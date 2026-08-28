#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, ConfigError, stateDir } from './core/config.mjs';
import { createLogger } from './core/logger.mjs';
import { createFsx } from './core/fsx.mjs';
import { discoverAddons, collectSchemas, initAddons } from './core/addon-loader.mjs';
import { validate, applyDefaults } from './core/schema.mjs';
import { JanitorError, Codes } from './core/errors.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const EX_CONFIG = 78; // sysexits.h, spec §8

async function main() {
  // Bootstrap load: we need disabledAddons and the log level before we can discover
  // add-ons, but we cannot validate add-on config sections until they are discovered.
  // So: load bare, discover, then re-load with the full merged schema set.
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(EX_CONFIG);
    }
    throw err;
  }

  const logger = createLogger({ level: config.log.level, file: config.log.file });
  logger.info('starting', { version: pkg.version, node: process.version });

  const addonsDir = path.join(here, 'addons');
  const discovered = await discoverAddons({ dir: addonsDir, logger });

  try {
    config = loadConfig({ addonSchemas: collectSchemas(discovered) });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(EX_CONFIG);
    }
    throw err;
  }

  const { tools, loaded, skipped } = await initAddons({
    discovered,
    config,
    logger,
    makeContext: ({ manifest, config: section, logger: childLogger }) => ({
      config: section,
      logger: childLogger,
      stateDir: stateDir(),
      // Each add-on gets an fsx bound to its own declared root, so the path jail is
      // per-add-on rather than global. A future screenshots add-on cannot reach into
      // Downloads and vice versa.
      fsx: section.root ? createFsx({ root: section.root, logger: childLogger }) : null,
      createFsx: (root) => createFsx({ root, logger: childLogger }),
      schema: { validate, applyDefaults }
    })
  });

  if (tools.size === 0) {
    logger.warn('no tools registered; the server will start but expose nothing', {
      discovered: discovered.length,
      skipped
    });
  }

  const server = new Server(
    { name: 'janitor-mcp', version: pkg.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = tools.get(name);
    if (!tool) {
      return errorResult(Codes.UNKNOWN_TOOL, `No such tool: ${name}`);
    }

    // Validate against the tool's declared JSON Schema and fill in defaults. Defaults
    // matter for safety here, not just convenience: `dryRun` defaults to true (spec
    // §6.3.1), so an omitted argument must become `true`, never `undefined`.
    const withDefaults = applyDefaults(tool.inputSchema, args);
    const errors = validate(tool.inputSchema, withDefaults);
    if (errors.length) {
      return errorResult(Codes.INVALID_INPUT, `Invalid arguments for ${name}: ${errors.join('; ')}`);
    }

    const started = Date.now();
    try {
      const result = await tool.handler(withDefaults);
      logger.debug('tool ok', { tool: name, ms: Date.now() - started });
      return normalizeResult(result);
    } catch (err) {
      if (err instanceof JanitorError) {
        logger.warn('tool failed', { tool: name, code: err.code, message: err.message });
        return errorResult(err.code, err.message, err.details);
      }
      logger.error('tool threw', { tool: name, error: err?.stack ?? String(err) });
      return errorResult(Codes.INTERNAL, `${name} failed unexpectedly: ${err?.message ?? err}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('connected on stdio', { tools: [...tools.keys()], addons: loaded });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      await server.close();
    } catch {
      /* the transport may already be gone; nothing useful to do */
    }
    await logger.flush();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Tool results carry a machine-parsable code plus a human sentence (spec §10) so the
 * model can self-correct — e.g. re-ask the user for confirmation on a destructive call.
 */
function errorResult(code, message, details) {
  const payload = { code, message, ...(details ? { details } : {}) };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true
  };
}

/** Add-ons may return a plain object; wrap it into MCP content shape. */
function normalizeResult(result) {
  if (result && Array.isArray(result.content)) return result;
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
  };
}

main().catch((err) => {
  // Last resort. stderr only — stdout belongs to the JSON-RPC stream.
  process.stderr.write(`janitor-mcp failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
});
