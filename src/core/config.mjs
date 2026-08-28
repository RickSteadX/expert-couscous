import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validate, applyDefaults } from './schema.mjs';

/**
 * Config loading (spec §8): defaults <- user config <- env overrides, validated against
 * the merged core + add-on schemas. A broken config is a startup failure, not a
 * degraded run, because silently ignoring a mistyped `protect` pattern would mean
 * deleting files the user asked to keep.
 */

export class ConfigError extends Error {
  constructor(errors) {
    super(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

export const stateDir = () =>
  process.env.JANITOR_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'janitor-mcp');
export const configPath = () =>
  process.env.JANITOR_CONFIG ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'janitor-mcp', 'config.json');

/** Schema for the core's own config section. Add-ons contribute their own (spec §5.2). */
export const coreSchema = {
  type: 'object',
  properties: {
    disabledAddons: { type: 'array', items: { type: 'string' }, default: [] },
    log: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['error', 'warn', 'info', 'debug'], default: 'info' },
        file: { type: 'string' }
      },
      default: { level: 'info' }
    },
    watcher: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: true },
        pollSeconds: { type: 'integer', minimum: 5, maximum: 3600, default: 30 },
        notify: { type: 'boolean', default: true },
        wakeLock: { type: 'boolean', default: true },
        ignore: { type: 'array', items: { type: 'string' }, default: ['*.crdownload', '*.part', '*.tmp'] },
        autoRules: { type: 'array', default: [] }
      },
      default: {}
    }
  }
};

/** Env overrides. Explicit map for the documented ones; JANITOR_X__Y for the rest. */
const ENV_MAP = {
  JANITOR_LOG_LEVEL: ['log', 'level'],
  JANITOR_LOG_FILE: ['log', 'file'],
  JANITOR_WATCHER_ENABLED: ['watcher', 'enabled'],
  JANITOR_WATCHER_POLL_SECONDS: ['watcher', 'pollSeconds'],
  JANITOR_WATCHER_NOTIFY: ['watcher', 'notify']
};

export function loadConfig({ file = configPath(), env = process.env, addonSchemas = {} } = {}) {
  let user = {};
  if (fs.existsSync(file)) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new ConfigError([`cannot read ${file}: ${err.code}`]);
    }
    try {
      user = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError([`${file} is not valid JSON: ${err.message}`]);
    }
    if (user === null || typeof user !== 'object' || Array.isArray(user)) {
      throw new ConfigError([`${file} must contain a JSON object`]);
    }
  }

  let merged = applyDefaults(coreSchema, user);
  for (const [name, schema] of Object.entries(addonSchemas)) {
    merged[name] = applyDefaults(schema, merged[name] ?? {});
  }
  merged = applyEnv(merged, env);

  const errors = validate(coreSchema, merged);
  for (const [name, schema] of Object.entries(addonSchemas)) {
    errors.push(...validate(schema, merged[name], name));
  }
  if (errors.length) throw new ConfigError(errors);

  if (!merged.log.file) merged.log.file = path.join(stateDir(), 'janitor.log');
  return merged;
}

function applyEnv(config, env) {
  const out = structuredClone(config);
  for (const [key, target] of Object.entries(ENV_MAP)) {
    if (env[key] !== undefined) setPath(out, target, coerce(env[key]));
  }
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('JANITOR_') || !key.includes('__') || key in ENV_MAP) continue;
    const segments = key.slice('JANITOR_'.length).split('__').map((s) => s.toLowerCase());
    setPath(out, segments, coerce(value));
  }
  return out;
}

function setPath(obj, segments, value) {
  let node = obj;
  for (const seg of segments.slice(0, -1)) {
    if (node[seg] === null || typeof node[seg] !== 'object') node[seg] = {};
    node = node[seg];
  }
  node[segments.at(-1)] = value;
}

/** Env values are strings; give the schema validator the type it expects. */
function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
