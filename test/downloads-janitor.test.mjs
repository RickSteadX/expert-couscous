import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import addon from '../src/addons/downloads-janitor/index.mjs';
import { categorize, buildCategoryMap, ageBucket, matchesPattern, formatBytes } from '../src/addons/downloads-janitor/rules.mjs';
import { createFsx } from '../src/core/fsx.mjs';
import { applyDefaults, validate } from '../src/core/schema.mjs';
import { Codes } from '../src/core/errors.mjs';

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child: () => quiet };
const tool = (name) => addon.tools.find((t) => t.name === name);

/** Call a tool the way server.mjs does, so declared defaults are actually exercised. */
async function call(name, args = {}) {
  const t = tool(name);
  const withDefaults = applyDefaults(t.inputSchema, args);
  const errors = validate(t.inputSchema, withDefaults);
  assert.deepEqual(errors, [], `arguments rejected: ${errors.join('; ')}`);
  return t.handler(withDefaults);
}

const DAY = 86_400_000;

function sandbox(files = {}, configOverrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-addon-'));
  const root = path.join(base, 'Download');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  for (const [rel, spec] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, spec.content ?? 'x'.repeat(spec.size ?? 1));
    if (spec.ageDays !== undefined) {
      const when = new Date(Date.now() - spec.ageDays * DAY);
      fs.utimesSync(abs, when, when);
    }
  }

  const config = applyDefaults(addon.configSchema, { root, ...configOverrides });
  addon.init({
    config,
    logger: quiet,
    stateDir,
    fsx: createFsx({ root, logger: quiet }),
    createFsx: (r) => createFsx({ root: r, logger: quiet }),
    schema: { validate, applyDefaults }
  });
  return { base, root, stateDir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// --- rules --------------------------------------------------------------------

test('categorizes by extension, including multi-part archive names', () => {
  const map = buildCategoryMap();
  assert.equal(categorize('holiday.JPG', map), 'images');
  assert.equal(categorize('clip.mp4', map), 'video');
  assert.equal(categorize('song.opus', map), 'audio');
  assert.equal(categorize('invoice.pdf', map), 'documents');
  assert.equal(categorize('backup.tar.gz', map), 'archives', '.tar.gz must not be read as a bare .gz');
  assert.equal(categorize('backup.tar', map), 'archives');
  assert.equal(categorize('app.apk', map), 'apk');
  assert.equal(categorize('README', map), 'other');
  assert.equal(categorize('mystery.qqq', map), 'other');
});

test('user category overrides move an extension rather than duplicating it', () => {
  const map = buildCategoryMap({ ebooks: ['epub', 'mobi'] });
  assert.equal(categorize('novel.epub', map), 'ebooks');
  assert.equal(categorize('report.pdf', map), 'documents');
});

test('age buckets follow the spec boundaries', () => {
  const now = Date.now();
  assert.equal(ageBucket(now - 1 * DAY, now), '<7d');
  assert.equal(ageBucket(now - 10 * DAY, now), '7-30d');
  assert.equal(ageBucket(now - 60 * DAY, now), '30-90d');
  assert.equal(ageBucket(now - 200 * DAY, now), '>90d');
});

test('glob matching is case-insensitive and slash-aware', () => {
  assert.ok(matchesPattern('*.pdf', 'invoice.PDF'), 'emulated storage is case-insensitive-ish');
  assert.ok(matchesPattern('invoice*', 'invoice-2026.pdf'));
  assert.ok(!matchesPattern('invoice*', 'sub/other.pdf'));
  assert.ok(matchesPattern('sub/*.pdf', 'sub/other.pdf'), 'a pattern with a slash matches the relative path');
  assert.ok(!matchesPattern('*.pdf', 'notes.pdf.txt'));
  assert.equal(formatBytes(1536), '1.5 KB');
});

// --- scan / list --------------------------------------------------------------

test('scan reports totals, category and age breakdowns, and trash size', async () => {
  const box = sandbox({
    'photo.jpg': { size: 1000, ageDays: 1 },
    'movie.mp4': { size: 5000, ageDays: 100 },
    'old.apk': { size: 2000, ageDays: 120 },
    'sub/doc.pdf': { size: 500, ageDays: 20 }
  });
  try {
    const scan = await call('downloads_scan');
    assert.equal(scan.totalFiles, 4);
    assert.equal(scan.totalBytes, 8500);
    assert.equal(scan.byCategory.images.count, 1);
    assert.equal(scan.byCategory.video.bytes, 5000);
    assert.equal(scan.byCategory.apk.count, 1);
    assert.equal(scan.byAge['<7d'].count, 1);
    assert.equal(scan.byAge['>90d'].count, 2);
    assert.equal(scan.largestFiles[0].path, 'movie.mp4');
    assert.equal(scan.trash.files, 0);

    await call('downloads_clean', { selector: { pattern: 'photo.jpg' }, dryRun: false });
    const after = await call('downloads_scan');
    assert.equal(after.totalFiles, 3, 'trashed files leave the main listing');
    assert.equal(after.trash.files, 1, 'and show up in the trash total');
    assert.equal(after.trash.bytes, 1000);
  } finally {
    box.cleanup();
  }
});

test('list filters, sorts largest first, and flags protected files', async () => {
  const box = sandbox(
    {
      'big.mp4': { size: 3000, ageDays: 200 },
      'small.mp4': { size: 100, ageDays: 200 },
      'recent.mp4': { size: 2000, ageDays: 1 },
      'invoice-2026.pdf': { size: 400, ageDays: 200 }
    },
    { protect: ['invoice*'] }
  );
  try {
    const videos = await call('downloads_list', { category: 'video' });
    assert.deepEqual(videos.files.map((f) => f.path), ['big.mp4', 'recent.mp4', 'small.mp4']);

    const old = await call('downloads_list', { olderThanDays: 90 });
    assert.equal(old.matched, 3);
    assert.ok(!old.files.some((f) => f.path === 'recent.mp4'));

    const large = await call('downloads_list', { largerThanMB: 0.0015 });
    assert.deepEqual(large.files.map((f) => f.path), ['big.mp4', 'recent.mp4']);

    const listed = await call('downloads_list', { pattern: 'invoice*' });
    assert.equal(listed.files[0].protected, true, 'listing shows protection without hiding the file');

    const limited = await call('downloads_list', { limit: 2 });
    assert.equal(limited.files.length, 2);
    assert.equal(limited.truncated, true);
  } finally {
    box.cleanup();
  }
});

// --- clean --------------------------------------------------------------------

test('clean defaults to a dry run and changes nothing', async () => {
  const box = sandbox({ 'old.apk': { size: 2000, ageDays: 120 } });
  try {
    // Note: no dryRun argument at all — the default must arrive as true.
    const result = await call('downloads_clean', { selector: { category: 'apk' } });
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldTrash, 1);
    assert.equal(result.reclaimableBytes, 2000);
    assert.ok(fs.existsSync(path.join(box.root, 'old.apk')), 'dry run must not move anything');
  } finally {
    box.cleanup();
  }
});

test('clean with dryRun:false trashes the matches and writes an undoable manifest', async () => {
  const box = sandbox({
    'old.apk': { size: 2000, ageDays: 120 },
    'new.apk': { size: 100, ageDays: 2 },
    'keep.jpg': { size: 300, ageDays: 200 }
  });
  try {
    const result = await call('downloads_clean', {
      selector: { category: 'apk', olderThanDays: 90 },
      dryRun: false
    });
    assert.equal(result.trashed, 1);
    assert.ok(result.manifestId);
    assert.equal(fs.existsSync(path.join(box.root, 'old.apk')), false);
    assert.ok(fs.existsSync(path.join(box.root, 'new.apk')), 'newer apk is outside the selector');
    assert.ok(fs.existsSync(path.join(box.root, 'keep.jpg')), 'other categories untouched');

    const undo = await call('downloads_undo', { manifestId: result.manifestId });
    assert.equal(undo.restored, 1);
    assert.ok(fs.existsSync(path.join(box.root, 'old.apk')), 'undo puts it back');
  } finally {
    box.cleanup();
  }
});

test('protected patterns survive every selector, including explicit paths', async () => {
  const box = sandbox(
    { 'invoice-2026.pdf': { size: 400, ageDays: 200 }, 'junk.pdf': { size: 400, ageDays: 200 } },
    { protect: ['invoice*'] }
  );
  try {
    const byCategory = await call('downloads_clean', { selector: { category: 'documents' } });
    assert.deepEqual(byCategory.files.map((f) => f.path), ['junk.pdf']);
    assert.deepEqual(byCategory.protectedSkipped, ['invoice-2026.pdf']);

    // Invariant 4: naming the file explicitly must not override protection.
    const byPath = await call('downloads_clean', {
      selector: { paths: ['invoice-2026.pdf'] },
      dryRun: false
    });
    assert.equal(byPath.trashed, 0);
    assert.deepEqual(byPath.protectedSkipped, ['invoice-2026.pdf']);
    assert.ok(fs.existsSync(path.join(box.root, 'invoice-2026.pdf')));
  } finally {
    box.cleanup();
  }
});

test('clean refuses an empty selector rather than matching everything', async () => {
  const box = sandbox({ 'a.jpg': { size: 10 }, 'b.jpg': { size: 10 } });
  try {
    await assert.rejects(
      () => call('downloads_clean', { selector: {}, dryRun: false }),
      (err) => {
        assert.equal(err.code, Codes.INVALID_INPUT);
        assert.match(err.message, /Refusing to select every file/);
        return true;
      }
    );
    assert.equal(fs.readdirSync(box.root).length, 2);
  } finally {
    box.cleanup();
  }
});

test('clean rejects paths outside the root', async () => {
  const box = sandbox({ 'a.jpg': { size: 10 } });
  try {
    await assert.rejects(
      () => call('downloads_clean', { selector: { paths: ['../outside.txt'] }, dryRun: false }),
      (err) => {
        assert.equal(err.code, Codes.PATH_ESCAPE);
        return true;
      }
    );
  } finally {
    box.cleanup();
  }
});

test('batch limits apply to dry runs too, keeping responses bounded', async () => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`f${i}.jpg`] = { size: 10, ageDays: 100 };
  const box = sandbox(files, { maxBatchFiles: 5 });
  try {
    await assert.rejects(
      () => call('downloads_clean', { selector: { category: 'images' } }),
      (err) => {
        assert.equal(err.code, Codes.BATCH_LIMIT);
        assert.match(err.message, /12 files/);
        assert.match(err.message, /Narrow the selector/);
        return true;
      }
    );
  } finally {
    box.cleanup();
  }
});

// --- dedupe -------------------------------------------------------------------

test('dedupe keeps the oldest of each identical set and ignores same-size non-duplicates', async () => {
  const box = sandbox({
    'copy-a.bin': { content: 'identical payload', ageDays: 30 },
    'copy-b.bin': { content: 'identical payload', ageDays: 10 },
    'copy-c.bin': { content: 'identical payload', ageDays: 1 },
    // Same byte length as each other but different content: must not be treated as dupes.
    'decoy-1.bin': { content: 'AAAA' },
    'decoy-2.bin': { content: 'BBBB' },
    'unique.bin': { content: 'something else entirely' }
  });
  try {
    const preview = await call('downloads_dedupe');
    assert.equal(preview.dryRun, true, 'dedupe must also default to a dry run');
    assert.equal(preview.duplicateSets, 1, 'same-size decoys must be ruled out by hashing');
    assert.equal(preview.wouldTrash, 2);
    assert.equal(preview.sets[0].keep.path, 'copy-a.bin', 'oldest copy is the keeper');

    const done = await call('downloads_dedupe', { dryRun: false });
    assert.equal(done.trashed, 2);
    assert.ok(fs.existsSync(path.join(box.root, 'copy-a.bin')));
    assert.equal(fs.existsSync(path.join(box.root, 'copy-b.bin')), false);
    assert.ok(fs.existsSync(path.join(box.root, 'decoy-1.bin')));
    assert.ok(fs.existsSync(path.join(box.root, 'decoy-2.bin')));

    const undo = await call('downloads_undo', { manifestId: done.manifestId });
    assert.equal(undo.restored, 2);
  } finally {
    box.cleanup();
  }
});

test('dedupe never trashes a protected file', async () => {
  const box = sandbox(
    { 'invoice-a.pdf': { content: 'same', ageDays: 30 }, 'invoice-b.pdf': { content: 'same', ageDays: 1 } },
    { protect: ['invoice*'] }
  );
  try {
    const preview = await call('downloads_dedupe');
    assert.equal(preview.duplicateSets, 0);
    assert.equal(preview.wouldTrash, 0);
  } finally {
    box.cleanup();
  }
});

// --- trash --------------------------------------------------------------------

test('empty_trash previews without confirm and deletes only with it', async () => {
  const box = sandbox({ 'junk.jpg': { size: 500, ageDays: 200 } });
  try {
    await call('downloads_clean', { selector: { category: 'images' }, dryRun: false });

    const preview = await call('downloads_empty_trash', { olderThanDays: 0 });
    assert.equal(preview.confirmRequired, true);
    assert.equal(preview.code, Codes.TRASH_CONFIRM_REQUIRED);
    assert.equal(preview.wouldDelete, 1);

    const stillThere = await call('downloads_scan');
    assert.equal(stillThere.trash.files, 1, 'preview must not delete');

    const retained = await call('downloads_empty_trash', { confirm: true });
    assert.equal(retained.deleted, 0, 'the 7-day default retention protects fresh trash');

    const done = await call('downloads_empty_trash', { olderThanDays: 0, confirm: true });
    assert.equal(done.deleted, 1);
    assert.equal(done.freedBytes, 500);

    const after = await call('downloads_scan');
    assert.equal(after.trash.files, 0);
  } finally {
    box.cleanup();
  }
});

test('undo reports a failure instead of throwing when the file is already gone', async () => {
  const box = sandbox({ 'junk.jpg': { size: 500, ageDays: 200 } });
  try {
    const cleaned = await call('downloads_clean', { selector: { category: 'images' }, dryRun: false });
    await call('downloads_empty_trash', { olderThanDays: 0, confirm: true });

    const undo = await call('downloads_undo', { manifestId: cleaned.manifestId });
    assert.equal(undo.restored, 0);
    assert.equal(undo.failed.length, 1);
    assert.match(undo.note, /permanently deleted/);
  } finally {
    box.cleanup();
  }
});

test('undo rejects a manifest id that tries to escape the manifests directory', async () => {
  const box = sandbox({});
  try {
    for (const bad of ['../../etc/passwd', 'a/b', '..', 'id with spaces']) {
      await assert.rejects(
        () => call('downloads_undo', { manifestId: bad }),
        (err) => {
          assert.ok([Codes.INVALID_INPUT, Codes.NOT_FOUND].includes(err.code), `${bad} -> ${err.code}`);
          return true;
        }
      );
    }
  } finally {
    box.cleanup();
  }
});

// --- events -------------------------------------------------------------------

test('event tools read the watcher queue and ack idempotently', async () => {
  const box = sandbox({});
  try {
    const empty = await call('downloads_events');
    assert.equal(empty.total, 0);
    assert.match(empty.note, /watcher service may not be running/);

    fs.writeFileSync(
      path.join(box.stateDir, 'events.jsonl'),
      [
        { id: 'e1', path: 'Download/setup.apk', size: 100, category: 'apk', detectedAt: '2026-08-28T09:00:00Z', acked: false },
        { id: 'e2', path: 'Download/clip.mp4', size: 200, category: 'video', detectedAt: '2026-08-28T10:00:00Z', acked: false },
        { id: 'e3', path: 'Download/old.zip', size: 300, category: 'archives', detectedAt: '2026-08-27T10:00:00Z', acked: true }
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\nnot json\n'
    );

    const unacked = await call('downloads_events');
    assert.equal(unacked.total, 3, 'the malformed line is skipped, not fatal');
    assert.deepEqual(unacked.events.map((e) => e.id), ['e2', 'e1'], 'newest first');

    const all = await call('downloads_events', { unackedOnly: false });
    assert.equal(all.events.length, 3);

    const acked = await call('downloads_events_ack', { ids: ['e1', 'nope'] });
    assert.equal(acked.acked, 1);
    assert.deepEqual(acked.unknownIds, ['nope']);
    assert.equal(acked.remainingUnacked, 1);

    const rest = await call('downloads_events_ack');
    assert.equal(rest.acked, 1);
    assert.equal((await call('downloads_events')).events.length, 0);
  } finally {
    box.cleanup();
  }
});

test('tools report STORAGE_NOT_GRANTED when the root is missing', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-nogrant-'));
  try {
    const missing = path.join(base, 'no', 'storage', 'downloads');
    addon.init({
      config: applyDefaults(addon.configSchema, { root: missing }),
      logger: quiet,
      stateDir: base,
      fsx: createFsx({ root: missing, logger: quiet }),
      createFsx: (r) => createFsx({ root: r, logger: quiet }),
      schema: { validate, applyDefaults }
    });
    await assert.rejects(
      () => call('downloads_scan'),
      (err) => {
        assert.equal(err.code, Codes.STORAGE_NOT_GRANTED);
        assert.match(err.message, /termux-setup-storage/);
        return true;
      }
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- sorting ------------------------------------------------------------------

test('sort defaults to a dry run and groups the plan by folder', async () => {
  const box = sandbox({
    'invoice-jan.pdf': { size: 100 },
    'invoice-feb.pdf': { size: 100 },
    'beach.jpg': { size: 200 }
  });
  try {
    // No dryRun argument: the default must arrive as true, same as clean and dedupe.
    const preview = await call('downloads_sort', {
      plan: [
        { folder: 'Tax 2026', paths: ['invoice-jan.pdf', 'invoice-feb.pdf'], reason: 'invoices for the tax year' },
        { folder: 'Holiday photos', paths: ['beach.jpg'] }
      ]
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.wouldMove, 3);
    assert.equal(preview.folders.length, 2);
    assert.equal(preview.folders[0].reason, 'invoices for the tax year');
    assert.ok(fs.existsSync(path.join(box.root, 'invoice-jan.pdf')), 'dry run must not move anything');
  } finally {
    box.cleanup();
  }
});

test('sort files into themed folders and undo restores the flat layout', async () => {
  const box = sandbox({ 'invoice-jan.pdf': { size: 100 }, 'beach.jpg': { size: 200 } });
  try {
    const result = await call('downloads_sort', {
      plan: [
        { folder: 'Tax 2026', paths: ['invoice-jan.pdf'] },
        { folder: 'Photos/2026', paths: ['beach.jpg'] }
      ],
      dryRun: false
    });
    assert.equal(result.moved, 2);
    assert.ok(fs.existsSync(path.join(box.root, 'Tax 2026', 'invoice-jan.pdf')));
    assert.ok(fs.existsSync(path.join(box.root, 'Photos', '2026', 'beach.jpg')), 'nested folders are allowed to maxSortFolderDepth');
    assert.equal(fs.existsSync(path.join(box.root, 'invoice-jan.pdf')), false);

    // Sorted files must still be visible to the other tools.
    const scan = await call('downloads_scan');
    assert.equal(scan.totalFiles, 2, 'sorted files stay in the inventory');
    assert.equal(scan.looseFiles, 0);
    assert.deepEqual(scan.folders.map((f) => f.folder).sort(), ['Photos', 'Tax 2026']);

    const undo = await call('downloads_undo', { manifestId: result.manifestId });
    assert.equal(undo.restored, 2);
    assert.ok(fs.existsSync(path.join(box.root, 'invoice-jan.pdf')), 'undo puts the flat layout back');
  } finally {
    box.cleanup();
  }
});

test('re-running the same sort plan is a no-op rather than churning suffixes', async () => {
  const box = sandbox({ 'invoice-jan.pdf': { size: 100 } });
  try {
    const plan = [{ folder: 'Tax 2026', paths: ['invoice-jan.pdf'] }];
    await call('downloads_sort', { plan, dryRun: false });

    const again = await call('downloads_sort', {
      plan: [{ folder: 'Tax 2026', paths: ['Tax 2026/invoice-jan.pdf'] }],
      dryRun: false
    });
    assert.equal(again.moved, 0);
    assert.deepEqual(again.skipped.alreadyPlaced, [path.join('Tax 2026', 'invoice-jan.pdf')]);
    assert.equal(fs.readdirSync(path.join(box.root, 'Tax 2026')).length, 1, 'no invoice-jan-1.pdf');
  } finally {
    box.cleanup();
  }
});

test('sort rejects hostile and unusable folder names', async () => {
  const box = sandbox({ 'a.jpg': { size: 10 } });
  try {
    const hostile = [
      '../escape',
      '../../etc',
      '/etc/passwd',
      '.janitor-trash',
      '.hidden',
      'a/b/c/d',
      'bad:name',
      'bad|name',
      'trailing ',
      'trailing.',
      ''
    ];
    for (const folder of hostile) {
      await assert.rejects(
        () => call('downloads_sort', { plan: [{ folder, paths: ['a.jpg'] }], dryRun: false }),
        (err) => {
          assert.ok(
            [Codes.PATH_ESCAPE, Codes.INVALID_INPUT].includes(err.code),
            `folder ${JSON.stringify(folder)} gave ${err.code}`
          );
          return true;
        },
        `folder ${JSON.stringify(folder)} should have been rejected`
      );
    }
    assert.ok(fs.existsSync(path.join(box.root, 'a.jpg')), 'nothing moved');
  } finally {
    box.cleanup();
  }
});

test('sort will not move protected files or files outside the root', async () => {
  const box = sandbox(
    { 'invoice-2026.pdf': { size: 100 }, 'junk.pdf': { size: 100 } },
    { protect: ['invoice*'] }
  );
  try {
    const result = await call('downloads_sort', {
      plan: [{ folder: 'Documents', paths: ['invoice-2026.pdf', 'junk.pdf'] }],
      dryRun: false
    });
    assert.equal(result.moved, 1);
    assert.deepEqual(result.skipped.protected, ['invoice-2026.pdf']);
    assert.ok(fs.existsSync(path.join(box.root, 'invoice-2026.pdf')), 'protected file stays put');

    await assert.rejects(
      () => call('downloads_sort', { plan: [{ folder: 'Documents', paths: ['../outside.txt'] }], dryRun: false }),
      (err) => {
        assert.equal(err.code, Codes.PATH_ESCAPE);
        return true;
      }
    );
  } finally {
    box.cleanup();
  }
});

test('sort handles name collisions, duplicate plan entries, and missing files', async () => {
  const box = sandbox({ 'report.pdf': { content: 'one' }, 'sub/report.pdf': { content: 'two' } });
  try {
    const result = await call('downloads_sort', {
      plan: [
        { folder: 'Docs', paths: ['report.pdf', 'sub/report.pdf', 'report.pdf', 'ghost.pdf'] }
      ],
      dryRun: false
    });
    assert.equal(result.moved, 2);
    assert.deepEqual(result.skipped.duplicatePlan, ['report.pdf']);
    assert.deepEqual(result.skipped.missing, ['ghost.pdf']);

    const filed = fs.readdirSync(path.join(box.root, 'Docs')).sort();
    assert.deepEqual(filed, ['report-1.pdf', 'report.pdf'], 'same-named files from different folders both survive');
  } finally {
    box.cleanup();
  }
});

test('sort refuses to file anything into the trash', async () => {
  const box = sandbox({ 'a.jpg': { size: 10 } });
  try {
    await assert.rejects(
      () => call('downloads_sort', { plan: [{ folder: '.janitor-trash/2026-01-01', paths: ['a.jpg'] }], dryRun: false }),
      (err) => {
        assert.ok([Codes.PATH_ESCAPE, Codes.INVALID_INPUT].includes(err.code));
        return true;
      }
    );
  } finally {
    box.cleanup();
  }
});

test('sort respects the batch cap', async () => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`f${i}.jpg`] = { size: 10 };
  const box = sandbox(files, { maxBatchFiles: 5 });
  try {
    await assert.rejects(
      () => call('downloads_sort', { plan: [{ folder: 'Photos', paths: Object.keys(files) }] }),
      (err) => {
        assert.equal(err.code, Codes.BATCH_LIMIT);
        return true;
      }
    );
  } finally {
    box.cleanup();
  }
});

test('cleaning still works on files that have been sorted into subfolders', async () => {
  const box = sandbox({ 'old.apk': { size: 100, ageDays: 200 } });
  try {
    await call('downloads_sort', { plan: [{ folder: 'Installers', paths: ['old.apk'] }], dryRun: false });
    const cleaned = await call('downloads_clean', {
      selector: { category: 'apk', olderThanDays: 90 },
      dryRun: false
    });
    assert.equal(cleaned.trashed, 1, 'category selectors still match inside theme folders');
  } finally {
    box.cleanup();
  }
});
