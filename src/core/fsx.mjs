import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JanitorError, Codes, storageNotGranted } from './errors.mjs';

/**
 * Shared safe-filesystem layer (spec §5.3).
 *
 * Every add-on goes through this; direct `fs` calls inside an add-on are a code-review
 * reject. `resolveJailed` is the single defense that makes these tools safe to hand to
 * an LLM, so it is deliberately paranoid and covered by test/fsx-jail.test.mjs.
 */

export const TRASH_DIRNAME = '.janitor-trash';

/** Expand a leading `~` and resolve to an absolute path. */
export function expandHome(p) {
  if (typeof p !== 'string') throw new TypeError('path must be a string');
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/**
 * @param {object} opts
 * @param {string} opts.root the add-on's declared root (e.g. ~/storage/downloads)
 * @param {object} [opts.logger]
 */
export function createFsx({ root, logger }) {
  const declaredRoot = expandHome(root);

  /**
   * The root itself is expected to be a symlink on Termux
   * (~/storage/downloads -> /storage/emulated/0/Download), so we resolve it once and
   * jail against the *real* path. Resolved lazily so that constructing fsx never throws
   * on a phone where the storage grant has not happened yet.
   */
  let realRoot = null;
  function getRealRoot() {
    if (realRoot) return realRoot;
    try {
      realRoot = fs.realpathSync(declaredRoot);
    } catch {
      throw storageNotGranted(root);
    }
    if (!fs.statSync(realRoot).isDirectory()) {
      throw new JanitorError(Codes.STORAGE_NOT_GRANTED, `${root} is not a directory.`, { root });
    }
    return realRoot;
  }

  /** True when the storage grant is in place; used by the doctor and by watcher_status. */
  function rootAvailable() {
    try {
      getRealRoot();
      return true;
    } catch {
      return false;
    }
  }

  function contains(parent, child) {
    return child === parent || child.startsWith(parent + path.sep);
  }

  /**
   * Resolve an untrusted path (anything that came from a tool call) to an absolute path
   * proven to live inside the root.
   *
   * Defends against: `..` traversal, absolute paths outside the root, NUL bytes,
   * sibling-prefix confusion (/a/bc vs /a/b), and symlinks that point out of the tree —
   * including symlinks on *intermediate* directories of a path that does not exist yet.
   *
   * Trusted paths produced by our own directory walk do not need this and should not pay
   * for it: on FUSE-backed storage a realpath() per file is measurable.
   */
  function resolveJailed(input) {
    if (typeof input !== 'string' || input.length === 0) {
      throw new JanitorError(Codes.INVALID_INPUT, 'Path must be a non-empty string.');
    }
    if (input.includes('\0')) {
      throw new JanitorError(Codes.PATH_ESCAPE, 'Path contains a null byte.', { input });
    }

    const base = getRealRoot();
    const candidate = path.isAbsolute(input)
      ? path.resolve(input)
      : path.resolve(base, input);

    // Lexical containment first — cheap, and rejects the common cases outright.
    if (!contains(base, candidate)) {
      throw new JanitorError(
        Codes.PATH_ESCAPE,
        `Path escapes the allowed root. Only files under ${root} can be accessed.`,
        { input }
      );
    }

    // Then physical containment: walk up to the deepest ancestor that exists, resolve
    // its symlinks, and re-check. This is what catches a symlink escape on a path whose
    // final component has not been created yet.
    let existing = candidate;
    const trailing = [];
    for (;;) {
      try {
        const real = fs.realpathSync(existing);
        const resolved = path.resolve(real, ...trailing.reverse());
        if (!contains(base, resolved)) {
          throw new JanitorError(
            Codes.PATH_ESCAPE,
            `Path resolves outside the allowed root via a symbolic link. Only files under ${root} can be accessed.`,
            { input }
          );
        }
        return resolved;
      } catch (err) {
        if (err instanceof JanitorError) throw err;
        if (err.code !== 'ENOENT') {
          throw new JanitorError(Codes.INTERNAL, `Cannot resolve path: ${err.code}`, { input });
        }
        const parent = path.dirname(existing);
        if (parent === existing) {
          // Ran out of ancestors without finding one that exists; lexical check stands.
          return candidate;
        }
        trailing.push(path.basename(existing));
        existing = parent;
      }
    }
  }

  /** Path of the trash directory, always inside the root so renames stay same-device. */
  function trashRoot() {
    return path.join(getRealRoot(), TRASH_DIRNAME);
  }

  function isInTrash(absPath) {
    return contains(trashRoot(), absPath);
  }

  /**
   * Depth-limited enumeration, shared by the janitor's scan and the watcher's poll so
   * both see exactly the same file set. Never descends into the trash.
   * @returns {Promise<Array<{abs: string, rel: string, size: number, mtimeMs: number}>>}
   */
  async function walk({ maxDepth = 3, signal } = {}) {
    const base = getRealRoot();
    const out = [];
    const stack = [{ dir: base, depth: 0 }];
    while (stack.length) {
      signal?.throwIfAborted();
      const { dir, depth } = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        logger?.warn('skipping unreadable directory', { dir, code: err.code });
        continue;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (abs === trashRoot()) continue;
          if (depth + 1 <= maxDepth) stack.push({ dir: abs, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue; // ignore sockets, fifos, dangling links
        try {
          const st = await fsp.stat(abs);
          out.push({ abs, rel: path.relative(base, abs), size: st.size, mtimeMs: st.mtimeMs });
        } catch (err) {
          logger?.debug('skipping unstatable file', { abs, code: err.code });
        }
      }
    }
    return out;
  }

  /**
   * Move a file into `<root>/.janitor-trash/<ISO-date>/`, never unlinking user data.
   * The trash lives inside the root precisely so this is a same-device rename, which is
   * atomic; a cross-device move to $HOME would be a copy+delete with a window where the
   * file exists in neither place.
   * @returns {Promise<{from: string, to: string}>}
   */
  async function atomicMoveToTrash(file) {
    const abs = resolveJailed(file);
    if (isInTrash(abs)) {
      throw new JanitorError(Codes.INVALID_INPUT, 'File is already in the trash.', { file });
    }
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      throw new JanitorError(Codes.NOT_FOUND, `No such file: ${file}`, { file });
    }
    if (!st.isFile()) {
      throw new JanitorError(Codes.INVALID_INPUT, `Not a regular file: ${file}`, { file });
    }

    const day = new Date().toISOString().slice(0, 10);
    const destDir = path.join(trashRoot(), day);
    await fsp.mkdir(destDir, { recursive: true });
    await ensureNoMedia();

    const to = await uniqueDestination(destDir, path.basename(abs));
    try {
      await fsp.rename(abs, to);
    } catch (err) {
      if (err.code === 'EXDEV') {
        throw new JanitorError(
          Codes.INTERNAL,
          'Trash is on a different filesystem than the file; this should be impossible because the trash lives inside the root.',
          { file }
        );
      }
      throw new JanitorError(Codes.INTERNAL, `Could not move file to trash: ${err.code}`, { file });
    }
    return { from: abs, to };
  }

  /** Move a file back out of the trash (spec §6.1 downloads_undo). */
  async function restoreFromTrash(from, to) {
    const src = resolveJailed(from);
    const dest = resolveJailed(to);
    if (!isInTrash(src)) {
      throw new JanitorError(Codes.INVALID_INPUT, 'Restore source is not inside the trash.', { from });
    }
    if (isInTrash(dest)) {
      throw new JanitorError(Codes.INVALID_INPUT, 'Restore destination is inside the trash.', { to });
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const finalDest = await uniqueDestination(path.dirname(dest), path.basename(dest));
    await fsp.rename(src, finalDest);
    return { from: src, to: finalDest };
  }

  /**
   * When a file entered the trash, derived from the `<ISO-date>/` partition it sits in.
   *
   * A rename preserves mtime, so a download from 200 days ago still has a 200-day-old
   * mtime the instant it is trashed. Dating retention off mtime would therefore purge it
   * on the very next empty_trash call and destroy the undo window — the opposite of what
   * a retention period is for. The date directory is the only record of when we moved it.
   */
  function trashedAtMs(relFromTrash, fallbackMtimeMs) {
    const [day] = relFromTrash.split(path.sep);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const parsed = Date.parse(`${day}T00:00:00Z`);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return fallbackMtimeMs;
  }

  /** List trash entries trashed more than N days ago, without deleting. Powers the dry run. */
  async function listTrash(olderThanDays = 0) {
    const base = trashRoot();
    if (!fs.existsSync(base)) return [];
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const out = [];
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
        } else if (entry.isFile() && entry.name !== '.nomedia') {
          const st = await fsp.stat(abs).catch(() => null);
          if (!st) continue;
          const rel = path.relative(base, abs);
          const trashedAt = trashedAtMs(rel, st.mtimeMs);
          if (trashedAt <= cutoff) {
            out.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs, trashedAtMs: trashedAt });
          }
        }
      }
    }
    return out;
  }

  /**
   * The ONLY function in the codebase that permanently deletes, and it refuses to touch
   * anything outside the trash (spec §5.3, §6.3.3).
   */
  async function emptyTrash(olderThanDays = 7) {
    const victims = await listTrash(olderThanDays);
    let bytes = 0;
    let deleted = 0;
    for (const v of victims) {
      if (!isInTrash(v.abs)) {
        // Belt and braces: listTrash only walks the trash, so this is unreachable by
        // construction. If it ever fires, something is very wrong and we stop.
        throw new JanitorError(Codes.PATH_ESCAPE, 'Refusing to delete outside the trash.', { path: v.rel });
      }
      try {
        await fsp.unlink(v.abs);
        bytes += v.size;
        deleted += 1;
      } catch (err) {
        logger?.warn('could not delete trash entry', { rel: v.rel, code: err.code });
      }
    }
    await pruneEmptyTrashDirs();
    return { deleted, bytes };
  }

  /**
   * Android's MediaStore keeps indexing files under the trash, so a "cleaned" photo
   * still shows up in Gallery. A .nomedia marker is what stops that.
   */
  async function ensureNoMedia() {
    const marker = path.join(trashRoot(), '.nomedia');
    try {
      await fsp.access(marker);
    } catch {
      await fsp.mkdir(trashRoot(), { recursive: true });
      await fsp.writeFile(marker, '');
    }
  }

  async function pruneEmptyTrashDirs() {
    const base = trashRoot();
    let days;
    try {
      days = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of days) {
      if (!d.isDirectory()) continue;
      const dir = path.join(base, d.name);
      const rest = await fsp.readdir(dir).catch(() => ['.']);
      if (rest.length === 0) await fsp.rmdir(dir).catch(() => {});
    }
  }

  async function uniqueDestination(dir, basename) {
    const ext = path.extname(basename);
    const stem = basename.slice(0, basename.length - ext.length);
    let attempt = path.join(dir, basename);
    for (let i = 1; ; i++) {
      try {
        await fsp.access(attempt);
      } catch {
        return attempt; // does not exist: free to use
      }
      attempt = path.join(dir, `${stem}-${i}${ext}`);
      if (i > 10_000) throw new JanitorError(Codes.INTERNAL, 'Too many name collisions in trash.');
    }
  }

  return {
    declaredRoot,
    getRealRoot,
    rootAvailable,
    resolveJailed,
    trashRoot,
    isInTrash,
    walk,
    atomicMoveToTrash,
    restoreFromTrash,
    listTrash,
    emptyTrash,
    ensureNoMedia
  };
}
