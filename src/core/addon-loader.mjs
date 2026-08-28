import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validate } from './schema.mjs';

/**
 * Add-on discovery and registration (spec §5.2).
 *
 * The core knows nothing about cleaning. It scans src/addons/, validates each manifest,
 * hands each add-on its own config section, and merges the resulting tool lists.
 *
 * A malformed or misconfigured add-on is skipped with a logged warning rather than
 * taking the server down: on a phone, losing every tool because one add-on has a typo in
 * its config is a much worse outcome than losing one add-on.
 */

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOOL_NAME_RE = /^[a-z0-9]+(_[a-z0-9]+)*$/;

/** Import every src/addons/<name>/index.mjs and return the ones that look like add-ons. */
export async function discoverAddons({ dir, logger }) {
  if (!fs.existsSync(dir)) {
    logger?.warn('add-on directory does not exist', { dir });
    return [];
  }
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const indexFile = path.join(dir, entry.name, 'index.mjs');
    if (!fs.existsSync(indexFile)) {
      logger?.warn('add-on directory has no index.mjs, skipping', { addon: entry.name });
      continue;
    }
    let module;
    try {
      module = await import(pathToFileURL(indexFile).href);
    } catch (err) {
      logger?.warn('add-on failed to import, skipping', { addon: entry.name, error: err.message });
      continue;
    }
    const manifest = module.default;
    const problems = manifestProblems(manifest, entry.name);
    if (problems.length) {
      logger?.warn('add-on manifest is invalid, skipping', { addon: entry.name, problems });
      continue;
    }
    found.push({ dirName: entry.name, manifest });
  }
  return found;
}

/** Config schemas keyed by add-on name, for the second (validating) config load. */
export function collectSchemas(discovered) {
  const out = {};
  for (const { manifest } of discovered) {
    if (manifest.configSchema) out[manifest.name] = manifest.configSchema;
  }
  return out;
}

/**
 * Initialise each enabled add-on and collect its tools.
 * @returns {Promise<{tools: Map<string, object>, loaded: string[], skipped: string[]}>}
 */
export async function initAddons({ discovered, config, logger, makeContext }) {
  const disabled = new Set(config.disabledAddons ?? []);
  const tools = new Map();
  const loaded = [];
  const skipped = [];

  for (const { manifest } of discovered) {
    const name = manifest.name;
    if (disabled.has(name)) {
      logger?.info('add-on disabled by config, skipping', { addon: name });
      skipped.push(name);
      continue;
    }

    const section = config[name] ?? {};
    if (manifest.configSchema) {
      const errors = validate(manifest.configSchema, section, name);
      if (errors.length) {
        logger?.warn('add-on config is invalid, skipping', { addon: name, errors });
        skipped.push(name);
        continue;
      }
    }

    const ctx = makeContext({ manifest, config: section, logger: logger?.child(name) });
    try {
      await manifest.init?.(ctx);
    } catch (err) {
      logger?.warn('add-on init failed, skipping', { addon: name, error: err.message });
      skipped.push(name);
      continue;
    }

    // Tool names are global and human-readable by design (spec §5.2) — no prefixing —
    // so a collision has to be caught here rather than silently shadowing.
    let collision = false;
    for (const tool of manifest.tools) {
      if (tools.has(tool.name)) {
        logger?.warn('duplicate tool name, skipping add-on', {
          addon: name,
          tool: tool.name,
          alreadyFrom: tools.get(tool.name).addon
        });
        collision = true;
        break;
      }
    }
    if (collision) {
      skipped.push(name);
      continue;
    }

    for (const tool of manifest.tools) {
      tools.set(tool.name, { ...tool, addon: name });
    }
    loaded.push(name);
    logger?.info('add-on loaded', { addon: name, version: manifest.version, tools: manifest.tools.length });
  }

  return { tools, loaded, skipped };
}

function manifestProblems(manifest, dirName) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['default export is not an object'];
  if (typeof manifest.name !== 'string' || !NAME_RE.test(manifest.name)) {
    problems.push('name must be a kebab-case string');
  } else if (manifest.name !== dirName) {
    problems.push(`name '${manifest.name}' does not match directory '${dirName}'`);
  }
  if (typeof manifest.version !== 'string') problems.push('version must be a string');
  if (!Array.isArray(manifest.tools)) {
    problems.push('tools must be an array');
    return problems;
  }
  manifest.tools.forEach((tool, i) => {
    const at = `tools[${i}]`;
    if (typeof tool?.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
      problems.push(`${at}.name must be a snake_case string`);
    }
    if (typeof tool?.description !== 'string' || tool.description.length === 0) {
      problems.push(`${at}.description is required`);
    }
    if (!tool?.inputSchema || typeof tool.inputSchema !== 'object') {
      problems.push(`${at}.inputSchema must be a JSON Schema object`);
    }
    if (typeof tool?.handler !== 'function') problems.push(`${at}.handler must be a function`);
  });
  return problems;
}
