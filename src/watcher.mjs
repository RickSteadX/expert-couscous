#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, ConfigError, stateDir } from './core/config.mjs';
import { createLogger } from './core/logger.mjs';
import { createFsx } from './core/fsx.mjs';
import { configSchema as janitorConfigSchema } from './addons/downloads-janitor/index.mjs';
import { buildCategoryMap, categorize, formatBytes, matchesAny, matchesPattern } from './addons/downloads-janitor/rules.mjs';

/**
 * Standalone new-file watcher (spec §7).
 *
 * Runs under termux-services, independent of any Claude Code session. It never talks to
 * the MCP server directly — an MCP stdio server only lives while a session holds it open
 * and cannot push messages — so the two communicate through an append-only event file
 * that either side can use without the other.
 *
 * READ-ONLY inside Downloads, by construction (acceptance criterion 10): this file calls
 * fsx.walk() and nothing else from the mutating side of fsx. Every write it makes goes to
 * the state directory. Keep it that way.
 */

const SNAPSHOT_VERSION = 2;
const MAX_EVENTS = 1000; // spec §7.2
const MAX_EVENTS_BYTES = 512 * 1024; // spec §7.2
const IGNORED_DIR_MARKER = 'no-storage-grant';

// --- pure logic (exported for tests) ------------------------------------------

/** @typedef {{size: number, mtimeMs: number}} Entry */

/** Snapshot shape persisted to disk so a reboot cannot lose an arrival. */
export function emptySnapshot() {
  return { version: SNAPSHOT_VERSION, updatedAt: null, files: {}, pending: {} };
}

/**
 * Diff the current listing against the previous snapshot.
 *
 * "Settled" (spec §7.2): a new file is only emitted once its size is identical across two
 * consecutive polls, which is what stops a half-written download being announced. Pending
 * candidates are persisted alongside the snapshot, so a watcher restart mid-download does
 * not re-arm the debounce from scratch.
 *
 * @param {Record<string, Entry>} current
 * @param {ReturnType<typeof emptySnapshot>} previous
 * @param {{ignore?: string[], firstRun?: boolean}} opts
 * @returns {{settled: string[], pending: Record<string, Entry>, files: Record<string, Entry>}}
 */
export function diffSnapshot(current, previous, { ignore = [] } = {}) {
  const known = previous.files ?? {};
  const wasPending = previous.pending ?? {};
  const settled = [];
  const pending = {};

  for (const [rel, entry] of Object.entries(current)) {
    // Browsers' partial-download names never become events, at any size.
    if (matchesAny(ignore, rel)) continue;
    if (rel in known) continue; // already reported

    const previouslyPending = wasPending[rel];
    if (previouslyPending && previouslyPending.size === entry.size) {
      settled.push(rel); // same size two polls running: the download has finished
    } else {
      pending[rel] = entry;
    }
  }

  // The new snapshot records everything currently present, plus what we just emitted, so
  // a file is never announced twice. Deletions fall out naturally by not being copied.
  const files = {};
  for (const [rel, entry] of Object.entries(current)) {
    if (rel in known || settled.includes(rel)) files[rel] = entry;
  }
  return { settled, pending, files };
}

/** First matching auto-rule, or undefined. Rules only ever tag (spec §7.3) — never move. */
export function matchAutoRule(rules, file) {
  for (const rule of rules ?? []) {
    const m = rule?.match ?? {};
    if (m.category !== undefined && m.category !== file.category) continue;
    if (m.largerThanMB !== undefined && file.size < m.largerThanMB * 1_048_576) continue;
    if (m.olderThanDays !== undefined && Date.now() - file.mtimeMs < m.olderThanDays * 86_400_000) continue;
    if (m.pattern !== undefined && !matchesPattern(m.pattern, file.rel)) continue;
    return rule.name;
  }
  return undefined;
}

export function buildEvent({ rel, size, mtimeMs, category, rule }) {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    id: `${stamp}-${crypto.randomBytes(2).toString('hex')}`,
    path: rel,
    size,
    category,
    detectedAt: new Date().toISOString(),
    acked: false,
    ...(rule ? { rule } : {}),
    ...(mtimeMs ? { modified: new Date(mtimeMs).toISOString() } : {})
  };
}

/**
 * Trim the queue to its caps, dropping acknowledged events first (spec §7.2). Unacked
 * events are what the next session still needs to see, so they are the last to go.
 */
export function rotateEvents(events, { maxEvents = MAX_EVENTS, maxBytes = MAX_EVENTS_BYTES } = {}) {
  let kept = [...events];
  const overBudget = () =>
    kept.length > maxEvents || Buffer.byteLength(kept.map((e) => JSON.stringify(e)).join('\n')) > maxBytes;

  while (overBudget()) {
    const oldestAcked = kept.findIndex((e) => e.acked);
    if (oldestAcked !== -1) kept.splice(oldestAcked, 1);
    else if (kept.length > 0) kept.shift();
    else break;
  }
  return kept;
}

// --- process plumbing ---------------------------------------------------------

function runCommand(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(command, args, { timeout: timeoutMs }, (err, stdout) => {
        resolve(err ? null : String(stdout).trim());
      });
    } catch {
      resolve(null);
      return;
    }
    child.on('error', () => resolve(null));
  });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Every state write is a temp-file replace, so a kill mid-write cannot corrupt it. */
async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}

async function readEvents(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* a torn line from an interrupted write: skip it rather than die */
    }
  }
  return out;
}

async function writeEvents(file, events) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  await fsp.rename(tmp, file);
}

export async function createWatcher({ config, logger, state = stateDir() }) {
  const watcherConfig = config.watcher;
  const janitorConfig = config['downloads-janitor'] ?? {};
  const fsx = createFsx({ root: janitorConfig.root, logger });
  const categoryMap = buildCategoryMap(janitorConfig.categories);
  const snapshotFile = path.join(state, 'snapshot.json');
  const eventsPath = path.join(state, 'events.jsonl');

  let termuxApi = null; // probed lazily, then cached

  async function notify(event) {
    if (!watcherConfig.notify) return;
    if (termuxApi === null) {
      termuxApi = (await runCommand('termux-notification-list', [], 5000)) !== null;
      if (!termuxApi) {
        logger.info('Termux:API is not available; notifications are disabled for this run (the queue still works)');
      }
    }
    if (!termuxApi) return;

    const name = path.basename(event.path);
    await runCommand('termux-notification', [
      '--title', `New download: ${name}`,
      '--content', `${formatBytes(event.size)}, ${event.category}${event.rule ? ` · ${event.rule}` : ''}`,
      '--group', 'Janitor',
      '--id', `janitor-${event.id}`,
      '--priority', 'low',
      '--action', 'am start -n com.termux/.app.TermuxActivity'
    ]);
  }

  /** One poll. Returns the events emitted, so --once and the tests can assert on them. */
  async function poll() {
    if (!fsx.rootAvailable()) {
      logger.warn('shared storage is not reachable; skipping poll', { root: janitorConfig.root, hint: 'run termux-setup-storage' });
      return { skipped: IGNORED_DIR_MARKER, events: [] };
    }

    const files = await fsx.walk({ maxDepth: janitorConfig.maxDepth ?? 3 });
    const current = {};
    for (const f of files) current[f.rel] = { size: f.size, mtimeMs: f.mtimeMs };

    const previous = await readJson(snapshotFile, emptySnapshot());
    const isFirstRun = previous.updatedAt === null;
    const { settled, pending, files: nextFiles } = diffSnapshot(current, previous, {
      ignore: watcherConfig.ignore
    });

    // A first run on an existing folder would otherwise announce every file ever
    // downloaded. Adopt what is already there as the baseline instead.
    if (isFirstRun) {
      await writeJsonAtomic(snapshotFile, {
        version: SNAPSHOT_VERSION,
        updatedAt: new Date().toISOString(),
        files: current,
        pending: {}
      });
      logger.info('adopted existing files as the baseline', { files: Object.keys(current).length });
      return { firstRun: true, events: [] };
    }

    const emitted = [];
    for (const rel of settled) {
      const entry = current[rel];
      const category = categorize(rel, categoryMap);
      const rule = matchAutoRule(watcherConfig.autoRules, { rel, size: entry.size, mtimeMs: entry.mtimeMs, category });
      emitted.push(buildEvent({ rel, size: entry.size, mtimeMs: entry.mtimeMs, category, rule }));
    }

    if (emitted.length > 0) {
      const existing = await readEvents(eventsPath);
      await writeEvents(eventsPath, rotateEvents([...existing, ...emitted]));
      for (const event of emitted) {
        logger.info('new download detected', { path: event.path, size: event.size, category: event.category, rule: event.rule });
        await notify(event);
      }
    }

    await writeJsonAtomic(snapshotFile, {
      version: SNAPSHOT_VERSION,
      updatedAt: new Date().toISOString(),
      files: nextFiles,
      pending
    });

    return { events: emitted, pending: Object.keys(pending).length, tracked: Object.keys(nextFiles).length };
  }

  return { poll, snapshotFile, eventsPath };
}

async function main() {
  const once = process.argv.includes('--once');
  let config;
  try {
    config = loadConfig({ addonSchemas: { 'downloads-janitor': janitorConfigSchema } });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(78);
    }
    throw err;
  }

  const logger = createLogger({ level: config.log.level, file: config.log.file, name: 'janitor-watcher' });

  if (!config.watcher.enabled && !once) {
    // Exiting would make runit restart us in a tight loop, so idle instead and let
    // `sv down janitor-watcher` be the way to stop the service.
    logger.info('watcher is disabled in config; idling');
    setInterval(() => {}, 1 << 30);
    return;
  }

  const watcher = await createWatcher({ config, logger });
  const intervalMs = config.watcher.pollSeconds * 1000;
  logger.info('watcher starting', { root: config['downloads-janitor']?.root, pollSeconds: config.watcher.pollSeconds });

  let wakeLockHeld = false;
  if (config.watcher.wakeLock && !once) {
    wakeLockHeld = (await runCommand('termux-wake-lock', [])) !== null;
    logger.info(wakeLockHeld ? 'partial wake lock acquired' : 'could not acquire a wake lock; polling anyway');
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info('watcher stopping', { signal });
    if (wakeLockHeld) await runCommand('termux-wake-unlock', []);
    await logger.flush();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const tick = async () => {
    try {
      const result = await watcher.poll();
      if (result.events?.length) logger.debug('poll emitted events', { count: result.events.length });
    } catch (err) {
      // Never die on a poll error: runit would restart us, and a permission blip should
      // not cost the snapshot continuity that makes arrivals during downtime detectable.
      logger.error('poll failed', { error: err?.message ?? String(err) });
    }
  };

  await tick();
  if (once) {
    await logger.flush();
    return;
  }
  setInterval(() => void tick(), intervalMs);
}

// Only run the loop when executed directly, so tests can import the pure helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`janitor-watcher failed to start: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
