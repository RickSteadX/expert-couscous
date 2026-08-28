import fs from 'node:fs';
import path from 'node:path';

/**
 * Logger for a stdio MCP server.
 *
 * CRITICAL (spec §4): nothing here may ever touch stdout. stdout carries MCP JSON-RPC
 * frames; a single stray write corrupts the stream and the session dies with a parse
 * error that looks nothing like its cause. All output goes to stderr and to a rotating
 * file.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_BYTES = 1024 * 1024; // 1 MB, spec §4
const MAX_ROTATIONS = 3; // janitor.log.1 .. .3, spec §10

export function createLogger({ level = 'info', file, stderr = true, name = 'janitor-mcp' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let written = 0;

  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      written = fs.existsSync(file) ? fs.statSync(file).size : 0;
      stream = fs.createWriteStream(file, { flags: 'a' });
      // A log file we cannot write is never a reason to take the server down.
      stream.on('error', () => { stream = null; });
    } catch {
      stream = null;
    }
  }

  function rotate() {
    if (!file) return;
    try {
      stream?.end();
      for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
        const from = `${file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
      }
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', () => { stream = null; });
      written = 0;
    } catch {
      stream = null;
    }
  }

  function emit(lvl, msg, meta) {
    if (LEVELS[lvl] > threshold) return;
    const line =
      `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${name}] ${msg}` +
      (meta === undefined ? '' : ` ${safeJson(meta)}`) +
      '\n';
    if (stderr) process.stderr.write(line);
    if (stream) {
      written += Buffer.byteLength(line);
      stream.write(line);
      if (written >= MAX_BYTES) rotate();
    }
  }

  const logger = {
    error: (m, meta) => emit('error', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    info: (m, meta) => emit('info', m, meta),
    debug: (m, meta) => emit('debug', m, meta),
    /** A logger that tags every line with an add-on name, handed to add-ons via ctx. */
    child: (childName) => createLogger({ level, file, stderr, name: `${name}:${childName}` }),
    flush: () => new Promise((resolve) => (stream ? stream.end(resolve) : resolve()))
  };
  return logger;
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}
