import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { JanitorError, Codes } from '../../core/errors.mjs';
import {
  AGE_BUCKETS,
  OTHER,
  ageBucket,
  buildCategoryMap,
  categorize,
  categoryNames,
  formatBytes,
  matchesAny,
  matchesPattern
} from './rules.mjs';

/**
 * Downloads janitor add-on (spec §6, plus the watcher-facing tools of §7.5).
 *
 * Safety invariants this file must uphold (spec §6.3), in one place so they are easy to
 * audit:
 *   1. dryRun defaults to true on every mutating tool.
 *   2. Nothing outside the configured root is read or written — enforced by fsx.
 *   3. The only permanent delete is downloads_empty_trash with confirm:true.
 *   4. Protected patterns are excluded from every selector, including explicit paths.
 *   5. A single clean/dedupe call is capped at maxBatchFiles / maxBatchBytes.
 */

const MANIFEST_ID_RE = /^[A-Za-z0-9._-]+$/;
const LARGEST_FILES_IN_SCAN = 10;
const MAX_LIST_LIMIT = 1000;

const configSchema = {
  type: 'object',
  properties: {
    root: { type: 'string', default: '~/storage/downloads' },
    maxDepth: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
    trashRetentionDays: { type: 'integer', minimum: 0, default: 7 },
    maxBatchFiles: { type: 'integer', minimum: 1, default: 500 },
    maxBatchBytes: { type: 'integer', minimum: 1, default: 5_368_709_120 },
    protect: { type: 'array', items: { type: 'string' }, default: [] },
    categories: { type: 'object', default: {} },
    maxSortFolderDepth: { type: 'integer', minimum: 1, maximum: 3, default: 2 }
  }
};

/** Populated by init(); every handler reads from here. */
let ctx = null;
let categoryMap = null;

function config() {
  return ctx.config;
}

/** Walk the root once and decorate each file with the attributes selectors filter on. */
async function inventory() {
  const files = await ctx.fsx.walk({ maxDepth: config().maxDepth });
  const now = Date.now();
  return files.map((f) => ({
    ...f,
    category: categorize(f.rel, categoryMap),
    age: ageBucket(f.mtimeMs, now)
  }));
}

function isProtected(relPath) {
  return matchesAny(config().protect, relPath);
}

/**
 * Turn a selector into a concrete file list.
 *
 * An empty selector is rejected rather than treated as "everything". The spec does not
 * say so explicitly, but a model that omits the selector by accident should not be one
 * `dryRun:false` away from trashing the whole folder.
 */
async function resolveSelection(selector = {}) {
  const { category, olderThanDays, largerThanMB, pattern, paths } = selector;
  const hasCriterion =
    category !== undefined ||
    olderThanDays !== undefined ||
    largerThanMB !== undefined ||
    pattern !== undefined ||
    (Array.isArray(paths) && paths.length > 0);

  if (!hasCriterion) {
    throw new JanitorError(
      Codes.INVALID_INPUT,
      'Selector is empty. Give at least one of: category, olderThanDays, largerThanMB, pattern, paths. Refusing to select every file.'
    );
  }

  let candidates;
  let missing = [];

  if (Array.isArray(paths) && paths.length > 0) {
    candidates = [];
    for (const p of paths) {
      const abs = ctx.fsx.resolveJailed(p); // throws PATH_ESCAPE on anything outside the root
      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        missing.push(p);
        continue;
      }
      if (!st.isFile()) {
        missing.push(p);
        continue;
      }
      const rel = path.relative(ctx.fsx.getRealRoot(), abs);
      candidates.push({
        abs,
        rel,
        size: st.size,
        mtimeMs: st.mtimeMs,
        category: categorize(rel, categoryMap),
        age: ageBucket(st.mtimeMs)
      });
    }
    // Explicit paths bypass the other criteria by design: naming a file is the criterion.
  } else {
    const now = Date.now();
    candidates = (await inventory()).filter((f) => {
      if (category !== undefined && f.category !== category) return false;
      if (olderThanDays !== undefined && now - f.mtimeMs < olderThanDays * 86_400_000) return false;
      if (largerThanMB !== undefined && f.size < largerThanMB * 1_048_576) return false;
      if (pattern !== undefined && !matchesPattern(pattern, f.rel)) return false;
      return true;
    });
  }

  // Invariant 4: protected files are removed last, so they survive even an explicit path.
  const protectedSkipped = candidates.filter((f) => isProtected(f.rel)).map((f) => f.rel);
  const selected = candidates.filter((f) => !isProtected(f.rel));
  selected.sort((a, b) => b.size - a.size);
  return { selected, protectedSkipped, missing };
}

/** Invariant 5. Applies to dry runs too, which is what keeps the MCP response bounded. */
function enforceBatchLimit(files, toolName) {
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  const { maxBatchFiles, maxBatchBytes } = config();
  if (files.length > maxBatchFiles || bytes > maxBatchBytes) {
    throw new JanitorError(
      Codes.BATCH_LIMIT,
      `${toolName} matched ${files.length} files (${formatBytes(bytes)}), over the per-call cap of ${maxBatchFiles} files / ${formatBytes(maxBatchBytes)}. Narrow the selector and run it in batches.`,
      { matched: files.length, bytes, maxBatchFiles, maxBatchBytes }
    );
  }
  return bytes;
}

// --- manifests (spec §6.1) ----------------------------------------------------

function manifestsDir() {
  return path.join(ctx.stateDir, 'manifests');
}

async function writeManifest(tool, moves) {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const manifest = { id, tool, createdAt: new Date().toISOString(), moves };
  await fsp.mkdir(manifestsDir(), { recursive: true });
  await fsp.writeFile(path.join(manifestsDir(), `${id}.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function readManifest(manifestId) {
  // The id reaches us from the model, so it is untrusted input to a path join.
  if (typeof manifestId !== 'string' || !MANIFEST_ID_RE.test(manifestId) || manifestId.includes('..')) {
    throw new JanitorError(Codes.INVALID_INPUT, `Invalid manifest id: ${manifestId}`);
  }
  const file = path.join(manifestsDir(), `${manifestId}.json`);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    throw new JanitorError(Codes.NOT_FOUND, `No manifest with id '${manifestId}'.`, { manifestId });
  }
}

// --- events queue (spec §7.2, §7.5) -------------------------------------------

function eventsFile() {
  return path.join(ctx.stateDir, 'events.jsonl');
}

async function readEvents() {
  let raw;
  try {
    raw = await fsp.readFile(eventsFile(), 'utf8');
  } catch {
    return []; // no watcher has ever run
  }
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      ctx.logger.warn('skipping malformed event line');
    }
  }
  return events;
}

/** Acking rewrites the file via a temp-file replace, per spec §7.2. */
async function writeEvents(events) {
  const target = eventsFile();
  const tmp = `${target}.tmp`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(tmp, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  await fsp.rename(tmp, target);
}

function run(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

/**
 * Validate a destination folder supplied by the model.
 *
 * This is the sorting equivalent of the path jail: a folder name reaches us as untrusted
 * text and is about to become a directory inside the user's storage. `resolveJailed`
 * would catch traversal on its own, but rejecting it here gives the model a message it
 * can act on instead of a generic escape error, and it also rules out names that are
 * legal on Linux but break on the FAT-like emulated volume.
 */
function validateSortFolder(folder) {
  if (typeof folder !== 'string' || folder.trim().length === 0) {
    throw new JanitorError(Codes.INVALID_INPUT, 'Each plan entry needs a non-empty folder name.');
  }
  if (folder.includes('\0')) {
    throw new JanitorError(Codes.PATH_ESCAPE, 'Folder name contains a null byte.', { folder });
  }
  if (path.isAbsolute(folder)) {
    throw new JanitorError(Codes.PATH_ESCAPE, `Folder must be relative to the Downloads root: '${folder}'.`, { folder });
  }

  const segments = folder.split('/').filter((seg) => seg.length > 0);
  const { maxSortFolderDepth } = config();
  if (segments.length === 0 || segments.length > maxSortFolderDepth) {
    throw new JanitorError(
      Codes.INVALID_INPUT,
      `Folder '${folder}' must have between 1 and ${maxSortFolderDepth} path segments.`,
      { folder }
    );
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new JanitorError(Codes.PATH_ESCAPE, `Folder '${folder}' must not contain '.' or '..'.`, { folder });
    }
    if (seg.startsWith('.')) {
      // Also what keeps a plan out of .janitor-trash.
      throw new JanitorError(Codes.INVALID_INPUT, `Folder segments must not start with a dot: '${seg}'.`, { folder });
    }
    if (/[<>:"\\|?*\x00-\x1f]/.test(seg)) {
      throw new JanitorError(
        Codes.INVALID_INPUT,
        `Folder '${seg}' contains characters that are not valid on Android shared storage (< > : " \\ | ? *).`,
        { folder }
      );
    }
    if (seg !== seg.trim() || seg.endsWith('.')) {
      throw new JanitorError(
        Codes.INVALID_INPUT,
        `Folder '${seg}' must not start or end with a space, or end with a dot — those are unreliable on FAT-like storage.`,
        { folder }
      );
    }
    if (seg.length > 64) {
      throw new JanitorError(Codes.INVALID_INPUT, `Folder segment '${seg}' is longer than 64 characters.`, { folder });
    }
  }
  return segments.join('/');
}

// --- tools --------------------------------------------------------------------

const tools = [
  {
    name: 'downloads_scan',
    description:
      'Summarise the Downloads folder: totals, breakdown by category and age, the largest files, likely duplicate sets, and the size of the janitor trash. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const files = await inventory();
      const byCategory = {};
      for (const name of categoryNames(config().categories)) byCategory[name] = { count: 0, bytes: 0 };
      const byAge = {};
      for (const bucket of AGE_BUCKETS) byAge[bucket] = { count: 0, bytes: 0 };

      let totalBytes = 0;
      const sizeGroups = new Map();
      for (const f of files) {
        totalBytes += f.size;
        const cat = byCategory[f.category] ?? (byCategory[f.category] = { count: 0, bytes: 0 });
        cat.count += 1;
        cat.bytes += f.size;
        byAge[f.age].count += 1;
        byAge[f.age].bytes += f.size;
        if (f.size > 0) {
          const group = sizeGroups.get(f.size);
          if (group) group.push(f);
          else sizeGroups.set(f.size, [f]);
        }
      }

      // Confirming duplicates needs hashing, which the spec deliberately keeps out of the
      // scan path for battery reasons (§2). Same-size grouping is the cheap proxy;
      // downloads_dedupe does the hashing and reports the real number.
      let probableDuplicateSets = 0;
      let probableReclaimableBytes = 0;
      for (const group of sizeGroups.values()) {
        if (group.length > 1) {
          probableDuplicateSets += 1;
          probableReclaimableBytes += group[0].size * (group.length - 1);
        }
      }

      const trash = await ctx.fsx.listTrash(0);
      const trashBytes = trash.reduce((sum, t) => sum + t.size, 0);

      // Existing theme folders, so a sort can reuse them instead of inventing a second
      // name for the same theme on every run.
      const folderNames = await ctx.fsx.listFolders();
      const folders = folderNames.map((name) => {
        const inFolder = files.filter((f) => f.rel === path.join(name, path.basename(f.rel)) || f.rel.startsWith(`${name}${path.sep}`));
        const bytes = inFolder.reduce((sum, f) => sum + f.size, 0);
        return { folder: name, files: inFolder.length, bytes, human: formatBytes(bytes) };
      });
      const looseFiles = files.filter((f) => !f.rel.includes(path.sep)).length;

      return {
        root: config().root,
        folders,
        looseFiles,
        totalFiles: files.length,
        totalBytes,
        totalHuman: formatBytes(totalBytes),
        byCategory: withHuman(byCategory),
        byAge: withHuman(byAge),
        largestFiles: [...files]
          .sort((a, b) => b.size - a.size)
          .slice(0, LARGEST_FILES_IN_SCAN)
          .map(publicFile),
        probableDuplicateSets,
        probableReclaimableBytes,
        probableReclaimableHuman: formatBytes(probableReclaimableBytes),
        trash: { files: trash.length, bytes: trashBytes, human: formatBytes(trashBytes) },
        note:
          probableDuplicateSets > 0
            ? 'Duplicate counts are based on file size only; run downloads_dedupe to confirm by hash.'
            : undefined
      };
    }
  },

  {
    name: 'downloads_list',
    description:
      'List files in Downloads matching a filter, largest first. Read-only. Use this to see exactly what a selector would match before cleaning.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'e.g. images, video, audio, documents, archives, apk, other' },
        olderThanDays: { type: 'integer', minimum: 0, description: 'Only files last modified more than N days ago' },
        largerThanMB: { type: 'number', minimum: 0, description: 'Only files at least this many MB' },
        pattern: { type: 'string', description: 'Glob against the filename, e.g. "invoice*" or "*.apk"' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: 100 }
      },
      additionalProperties: false
    },
    handler: async ({ category, olderThanDays, largerThanMB, pattern, limit }) => {
      const now = Date.now();
      const all = await inventory();
      const matched = all.filter((f) => {
        if (category !== undefined && f.category !== category) return false;
        if (olderThanDays !== undefined && now - f.mtimeMs < olderThanDays * 86_400_000) return false;
        if (largerThanMB !== undefined && f.size < largerThanMB * 1_048_576) return false;
        if (pattern !== undefined && !matchesPattern(pattern, f.rel)) return false;
        return true;
      });
      matched.sort((a, b) => b.size - a.size);
      const bytes = matched.reduce((sum, f) => sum + f.size, 0);
      return {
        matched: matched.length,
        totalBytes: bytes,
        totalHuman: formatBytes(bytes),
        truncated: matched.length > limit,
        files: matched.slice(0, limit).map((f) => ({ ...publicFile(f), protected: isProtected(f.rel) }))
      };
    }
  },

  {
    name: 'downloads_clean',
    description:
      'Move files matching a selector into the janitor trash. Defaults to a dry run: call once to see the list, then again with dryRun:false once the user has confirmed. Never deletes permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'object',
          properties: {
            category: { type: 'string' },
            olderThanDays: { type: 'integer', minimum: 0 },
            largerThanMB: { type: 'number', minimum: 0 },
            pattern: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Explicit paths relative to the Downloads root' }
          }
        },
        dryRun: { type: 'boolean', default: true }
      },
      required: ['selector'],
      additionalProperties: false
    },
    handler: async ({ selector, dryRun }) => {
      const { selected, protectedSkipped, missing } = await resolveSelection(selector);
      const bytes = enforceBatchLimit(selected, 'downloads_clean');

      if (dryRun) {
        return {
          dryRun: true,
          wouldTrash: selected.length,
          reclaimableBytes: bytes,
          reclaimableHuman: formatBytes(bytes),
          protectedSkipped,
          missing,
          files: selected.map(publicFile),
          next: 'Call downloads_clean again with dryRun:false to move these to the trash.'
        };
      }

      const moves = [];
      const failed = [];
      for (const file of selected) {
        try {
          moves.push(await ctx.fsx.atomicMoveToTrash(file.abs));
        } catch (err) {
          failed.push({ path: file.rel, error: err.message });
        }
      }
      const manifest = await writeManifest('downloads_clean', moves);
      const movedBytes = selected
        .filter((f) => moves.some((m) => m.from === f.abs))
        .reduce((sum, f) => sum + f.size, 0);

      ctx.logger.info('cleaned', { moved: moves.length, bytes: movedBytes, manifestId: manifest.id });
      return {
        dryRun: false,
        manifestId: manifest.id,
        trashed: moves.length,
        reclaimedBytes: movedBytes,
        reclaimedHuman: formatBytes(movedBytes),
        protectedSkipped,
        failed,
        note: `Files are in the trash, not deleted. Space is only freed by downloads_empty_trash. Undo with downloads_undo manifestId:"${manifest.id}".`
      };
    }
  },

  {
    name: 'downloads_dedupe',
    description:
      'Find byte-identical duplicates (grouped by size, then confirmed by SHA-256), keep the oldest copy of each, and trash the rest. Defaults to a dry run.',
    inputSchema: {
      type: 'object',
      properties: { dryRun: { type: 'boolean', default: true } },
      additionalProperties: false
    },
    handler: async ({ dryRun }) => {
      const files = (await inventory()).filter((f) => f.size > 0 && !isProtected(f.rel));

      // Size-gated and lazy (spec §2): hashing only happens inside same-size groups, so a
      // folder of uniquely-sized files costs zero hashes.
      const bySize = new Map();
      for (const f of files) {
        const group = bySize.get(f.size);
        if (group) group.push(f);
        else bySize.set(f.size, [f]);
      }

      const sets = [];
      for (const group of bySize.values()) {
        if (group.length < 2) continue;
        const byHash = new Map();
        for (const f of group) {
          const hash = await sha256(f.abs);
          if (!hash) continue; // unreadable; leave it alone
          const bucket = byHash.get(hash);
          if (bucket) bucket.push(f);
          else byHash.set(hash, [f]);
        }
        for (const [hash, identical] of byHash) {
          if (identical.length < 2) continue;
          identical.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first: that one stays
          sets.push({ hash, keep: identical[0], trash: identical.slice(1) });
        }
      }

      const victims = sets.flatMap((s) => s.trash);
      const bytes = enforceBatchLimit(victims, 'downloads_dedupe');

      if (dryRun) {
        return {
          dryRun: true,
          duplicateSets: sets.length,
          wouldTrash: victims.length,
          reclaimableBytes: bytes,
          reclaimableHuman: formatBytes(bytes),
          sets: sets.map((s) => ({
            keep: publicFile(s.keep),
            trash: s.trash.map(publicFile),
            eachBytes: s.keep.size
          })),
          next: 'Call downloads_dedupe again with dryRun:false to trash the redundant copies.'
        };
      }

      const moves = [];
      const failed = [];
      for (const file of victims) {
        try {
          moves.push(await ctx.fsx.atomicMoveToTrash(file.abs));
        } catch (err) {
          failed.push({ path: file.rel, error: err.message });
        }
      }
      const manifest = await writeManifest('downloads_dedupe', moves);
      ctx.logger.info('deduped', { sets: sets.length, moved: moves.length, manifestId: manifest.id });
      return {
        dryRun: false,
        manifestId: manifest.id,
        duplicateSets: sets.length,
        trashed: moves.length,
        reclaimedBytes: bytes,
        reclaimedHuman: formatBytes(bytes),
        failed,
        note: `Undo with downloads_undo manifestId:"${manifest.id}".`
      };
    }
  },

  {
    name: 'downloads_undo',
    description: 'Restore a previous downloads_clean or downloads_dedupe batch from its manifest id, moving the files back out of the trash.',
    inputSchema: {
      type: 'object',
      properties: { manifestId: { type: 'string' } },
      required: ['manifestId'],
      additionalProperties: false
    },
    handler: async ({ manifestId }) => {
      const manifest = await readManifest(manifestId);
      const restored = [];
      const failed = [];
      for (const move of manifest.moves) {
        try {
          const back = await ctx.fsx.restoreMove(move.to, move.from);
          restored.push(path.relative(ctx.fsx.getRealRoot(), back.to));
        } catch (err) {
          failed.push({ path: move.from, error: err.message });
        }
      }
      ctx.logger.info('undo', { manifestId, restored: restored.length, failed: failed.length });
      return {
        manifestId,
        tool: manifest.tool,
        restored: restored.length,
        failed,
        files: restored,
        note: failed.length
          ? 'Some files could not be restored; they may already have been permanently deleted by downloads_empty_trash.'
          : undefined
      };
    }
  },

  {
    name: 'downloads_empty_trash',
    description:
      'Permanently delete janitor trash older than N days. This is the only tool that deletes anything for good, and the only one that actually frees space. Requires confirm:true; without it, returns what would be deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        olderThanDays: { type: 'integer', minimum: 0, default: 7 },
        confirm: { type: 'boolean', default: false }
      },
      additionalProperties: false
    },
    handler: async ({ olderThanDays, confirm }) => {
      const victims = await ctx.fsx.listTrash(olderThanDays);
      const bytes = victims.reduce((sum, v) => sum + v.size, 0);

      if (!confirm) {
        // A preview rather than an isError, per §6.1 — but it carries the §10 code so the
        // model can recognise the state and go ask the user for confirmation.
        return {
          code: Codes.TRASH_CONFIRM_REQUIRED,
          confirmRequired: true,
          olderThanDays,
          wouldDelete: victims.length,
          bytes,
          human: formatBytes(bytes),
          files: victims.slice(0, 200).map((v) => ({ path: v.rel, size: v.size, human: formatBytes(v.size) })),
          message:
            'Nothing was deleted. This is permanent and cannot be undone — ask the user to confirm, then call again with confirm:true.'
        };
      }

      const result = await ctx.fsx.emptyTrash(olderThanDays);
      ctx.logger.info('emptied trash', { deleted: result.deleted, bytes: result.bytes });
      return {
        deleted: result.deleted,
        freedBytes: result.bytes,
        freedHuman: formatBytes(result.bytes),
        note: 'Permanently deleted. downloads_undo can no longer restore these.'
      };
    }
  },

  {
    name: 'downloads_sort',
    description:
      "File loose downloads into themed subfolders inside Downloads. You decide the themes: call downloads_scan or downloads_list first to see what is there and which folders already exist, then submit a plan mapping folder names to the files that belong in them. Themes can be anything meaningful to the user — 'Tax 2026', 'Holiday photos', 'Work PDFs' — not just file types. Defaults to a dry run.",
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'array',
          description: 'One entry per destination folder.',
          items: {
            type: 'object',
            properties: {
              folder: {
                type: 'string',
                description: "Destination folder relative to the Downloads root, e.g. 'Invoices' or 'Photos/2026'."
              },
              paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Paths relative to the Downloads root, as returned by downloads_list.'
              },
              reason: { type: 'string', description: 'Optional one-line note on why these belong together; echoed back in the dry run.' }
            },
            required: ['folder', 'paths']
          }
        },
        dryRun: { type: 'boolean', default: true }
      },
      required: ['plan'],
      additionalProperties: false
    },
    handler: async ({ plan, dryRun }) => {
      if (plan.length === 0) {
        throw new JanitorError(Codes.INVALID_INPUT, 'The plan is empty. Give at least one folder with at least one file.');
      }

      const root = ctx.fsx.getRealRoot();
      const moves = [];
      const skipped = { protected: [], alreadyPlaced: [], missing: [], duplicatePlan: [] };
      const seen = new Set();

      for (const entry of plan) {
        const folder = validateSortFolder(entry.folder);
        for (const p of entry.paths) {
          const abs = ctx.fsx.resolveJailed(p); // PATH_ESCAPE on anything outside the root
          const rel = path.relative(root, abs);

          // A file named twice in one plan would otherwise be moved, then "moved" again
          // from a path that no longer exists.
          if (seen.has(abs)) {
            skipped.duplicatePlan.push(rel);
            continue;
          }
          seen.add(abs);

          if (isProtected(rel)) {
            skipped.protected.push(rel);
            continue;
          }
          let st;
          try {
            st = await fsp.stat(abs);
          } catch {
            skipped.missing.push(rel);
            continue;
          }
          if (!st.isFile()) {
            skipped.missing.push(rel);
            continue;
          }
          if (path.dirname(rel) === folder) {
            // Re-running the same plan must be a no-op, not a churn of -1 suffixes.
            skipped.alreadyPlaced.push(rel);
            continue;
          }
          moves.push({ abs, rel, size: st.size, folder, to: path.join(folder, path.basename(rel)), reason: entry.reason });
        }
      }

      enforceBatchLimit(moves, 'downloads_sort');

      if (dryRun) {
        const byFolder = {};
        for (const m of moves) {
          (byFolder[m.folder] ??= { files: [], bytes: 0, reason: m.reason }).files.push(m.rel);
          byFolder[m.folder].bytes += m.size;
        }
        return {
          dryRun: true,
          wouldMove: moves.length,
          folders: Object.entries(byFolder).map(([folder, v]) => ({
            folder,
            files: v.files,
            bytes: v.bytes,
            human: formatBytes(v.bytes),
            reason: v.reason
          })),
          skipped,
          next: 'Call downloads_sort again with dryRun:false to file these. Nothing is deleted — undo restores the original layout.'
        };
      }

      const done = [];
      const failed = [];
      for (const move of moves) {
        try {
          done.push(await ctx.fsx.moveWithinRoot(move.abs, move.folder));
        } catch (err) {
          failed.push({ path: move.rel, error: err.message });
        }
      }
      const manifest = await writeManifest('downloads_sort', done);
      ctx.logger.info('sorted', { moved: done.length, folders: new Set(moves.map((m) => m.folder)).size, manifestId: manifest.id });

      return {
        dryRun: false,
        manifestId: manifest.id,
        moved: done.length,
        folders: [...new Set(moves.map((m) => m.folder))].sort(),
        skipped,
        failed,
        note: `Nothing was deleted — files were filed into subfolders. Undo the whole batch with downloads_undo manifestId:"${manifest.id}".`
      };
    }
  },

  {
    name: 'downloads_events',
    description:
      'List new-file events queued by the background watcher — files that arrived in Downloads while no session was running. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        unackedOnly: { type: 'boolean', default: true },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 }
      },
      additionalProperties: false
    },
    handler: async ({ unackedOnly, limit }) => {
      const all = await readEvents();
      const filtered = unackedOnly ? all.filter((e) => !e.acked) : all;
      filtered.sort((a, b) => String(b.detectedAt).localeCompare(String(a.detectedAt)));
      return {
        total: all.length,
        unacked: all.filter((e) => !e.acked).length,
        returned: Math.min(filtered.length, limit),
        events: filtered.slice(0, limit),
        note: all.length === 0 ? 'The event queue is empty. The watcher service may not be running yet.' : undefined
      };
    }
  },

  {
    name: 'downloads_events_ack',
    description: 'Mark watcher events as acknowledged so they stop appearing in downloads_events. Omit ids to ack everything.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false
    },
    handler: async ({ ids }) => {
      const all = await readEvents();
      const target = ids === undefined ? null : new Set(ids);
      let acked = 0;
      for (const event of all) {
        if ((target === null || target.has(event.id)) && !event.acked) {
          event.acked = true;
          acked += 1;
        }
      }
      if (acked > 0) await writeEvents(all);
      const unknown = target ? [...target].filter((id) => !all.some((e) => e.id === id)) : [];
      return { acked, remainingUnacked: all.filter((e) => !e.acked).length, unknownIds: unknown };
    }
  },

  {
    name: 'watcher_status',
    description: 'Report whether the background download watcher is running, when it last polled, and how deep the event queue is.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const svStatus = await run('sv', ['status', 'janitor-watcher']);
      const snapshotPath = path.join(ctx.stateDir, 'snapshot.json');
      let snapshot = null;
      try {
        const st = await fsp.stat(snapshotPath);
        snapshot = { lastPollAt: new Date(st.mtimeMs).toISOString(), bytes: st.size };
      } catch {
        /* the watcher has never written one */
      }
      const events = await readEvents();
      const termuxApi = (await run('termux-notification-list', [], 4000)) !== null;

      return {
        serviceRunning: typeof svStatus === 'string' && svStatus.startsWith('run'),
        serviceStatus: svStatus ?? 'unavailable (termux-services not installed, or service not enabled)',
        snapshot,
        queueDepth: events.filter((e) => !e.acked).length,
        totalEvents: events.length,
        termuxApiAvailable: termuxApi,
        note: termuxApi
          ? undefined
          : 'Termux:API is not responding, so the watcher cannot raise Android notifications. The event queue still works.'
      };
    }
  }
];

// --- helpers ------------------------------------------------------------------

function publicFile(f) {
  return {
    path: f.rel,
    size: f.size,
    human: formatBytes(f.size),
    modified: new Date(f.mtimeMs).toISOString(),
    category: f.category
  };
}

function withHuman(groups) {
  const out = {};
  for (const [key, value] of Object.entries(groups)) {
    out[key] = { ...value, human: formatBytes(value.bytes) };
  }
  return out;
}

function sha256(absPath) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', () => resolve(null));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export default {
  name: 'downloads-janitor',
  version: '1.0.0',
  configSchema,
  init(context) {
    ctx = context;
    if (!ctx.fsx) {
      throw new Error('downloads-janitor requires a configured root');
    }
    categoryMap = buildCategoryMap(ctx.config.categories);
    // Deliberately not touching the filesystem here: on a phone without the storage grant
    // the server must still start and let the tools report STORAGE_NOT_GRANTED with an
    // actionable message, rather than failing to load and leaving no tools at all.
    ctx.logger.info('downloads-janitor ready', { root: ctx.config.root, protect: ctx.config.protect.length });
  },
  tools
};

export { OTHER, configSchema };
