import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  emptySnapshot,
  diffSnapshot,
  matchAutoRule,
  buildEvent,
  rotateEvents,
  createWatcher
} from '../src/watcher.mjs';
import { applyDefaults } from '../src/core/schema.mjs';
import { coreSchema } from '../src/core/config.mjs';
import { configSchema as janitorSchema } from '../src/addons/downloads-janitor/index.mjs';

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child: () => quiet };

// --- pure diff logic ----------------------------------------------------------

const entry = (size, mtimeMs = Date.now()) => ({ size, mtimeMs });

test('a new file is only settled once its size holds across two polls', () => {
  const previous = { ...emptySnapshot(), updatedAt: '2026-08-28T09:00:00Z' };

  // Poll 1: mid-download, so it becomes pending rather than an event.
  const first = diffSnapshot({ 'big.iso': entry(1000) }, previous);
  assert.deepEqual(first.settled, []);
  assert.deepEqual(Object.keys(first.pending), ['big.iso']);

  // Poll 2: still growing.
  const second = diffSnapshot({ 'big.iso': entry(5000) }, { ...previous, ...first });
  assert.deepEqual(second.settled, [], 'a growing file must not be announced');
  assert.equal(second.pending['big.iso'].size, 5000);

  // Poll 3: size unchanged, so the download has finished.
  const third = diffSnapshot({ 'big.iso': entry(5000) }, { ...previous, ...second });
  assert.deepEqual(third.settled, ['big.iso']);
  assert.deepEqual(third.pending, {});
  assert.ok('big.iso' in third.files, 'settled files enter the snapshot');
});

test('a settled file is never announced twice', () => {
  const previous = { ...emptySnapshot(), updatedAt: 'x', files: { 'a.jpg': entry(10) } };
  const result = diffSnapshot({ 'a.jpg': entry(10) }, previous);
  assert.deepEqual(result.settled, []);
  assert.ok('a.jpg' in result.files);
});

test('partial-download names are ignored at any size', () => {
  const ignore = ['*.crdownload', '*.part', '*.tmp'];
  const previous = { ...emptySnapshot(), updatedAt: 'x' };
  const stable = { 'movie.mp4.crdownload': entry(500), 'notes.part': entry(500), 'x.tmp': entry(500) };

  const first = diffSnapshot(stable, previous, { ignore });
  assert.deepEqual(first.settled, []);
  assert.deepEqual(first.pending, {}, 'ignored names never even become pending');

  const second = diffSnapshot(stable, { ...previous, ...first }, { ignore });
  assert.deepEqual(second.settled, [], 'and never settle, however long they sit there');
});

test('deletions drop out of the snapshot without producing events', () => {
  const previous = { ...emptySnapshot(), updatedAt: 'x', files: { 'a.jpg': entry(10), 'b.jpg': entry(20) } };
  const result = diffSnapshot({ 'a.jpg': entry(10) }, previous);
  assert.deepEqual(result.settled, []);
  assert.deepEqual(Object.keys(result.files), ['a.jpg']);
});

test('auto-rules tag the first match and only ever tag', () => {
  const rules = [
    { name: 'big-video', match: { category: 'video', largerThanMB: 300 } },
    { name: 'any-apk', match: { category: 'apk' } }
  ];
  assert.equal(matchAutoRule(rules, { rel: 'a.mp4', size: 400 * 1_048_576, category: 'video', mtimeMs: Date.now() }), 'big-video');
  assert.equal(matchAutoRule(rules, { rel: 'a.mp4', size: 10, category: 'video', mtimeMs: Date.now() }), undefined, 'size gate applies');
  assert.equal(matchAutoRule(rules, { rel: 'a.apk', size: 10, category: 'apk', mtimeMs: Date.now() }), 'any-apk');
  assert.equal(matchAutoRule([], { rel: 'a.jpg', size: 1, category: 'images', mtimeMs: Date.now() }), undefined);
});

test('event ids are unique and carry the documented fields', () => {
  const a = buildEvent({ rel: 'setup.apk', size: 48211234, mtimeMs: Date.now(), category: 'apk', rule: 'any-apk' });
  const b = buildEvent({ rel: 'setup.apk', size: 48211234, mtimeMs: Date.now(), category: 'apk' });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z-[0-9a-f]{4}$/);
  assert.equal(a.path, 'setup.apk');
  assert.equal(a.acked, false);
  assert.equal(a.rule, 'any-apk');
  assert.equal(b.rule, undefined);
});

test('rotation drops acknowledged events first', () => {
  const events = [
    { id: 'old-acked', acked: true },
    { id: 'old-unacked', acked: false },
    { id: 'new-acked', acked: true },
    { id: 'new-unacked', acked: false }
  ];
  const kept = rotateEvents(events, { maxEvents: 2, maxBytes: 1e6 });
  assert.deepEqual(kept.map((e) => e.id), ['old-unacked', 'new-unacked'], 'unacked events survive longest');

  // When only unacked remain and we are still over budget, the oldest goes.
  const allUnacked = [{ id: 'a', acked: false }, { id: 'b', acked: false }, { id: 'c', acked: false }];
  assert.deepEqual(rotateEvents(allUnacked, { maxEvents: 2, maxBytes: 1e6 }).map((e) => e.id), ['b', 'c']);
});

test('rotation also respects the byte budget', () => {
  const events = Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, acked: true, path: 'x'.repeat(100) }));
  const kept = rotateEvents(events, { maxEvents: 1000, maxBytes: 1000 });
  assert.ok(kept.length < 50);
  assert.ok(Buffer.byteLength(kept.map((e) => JSON.stringify(e)).join('\n')) <= 1000);
});

// --- the watcher against a real directory -------------------------------------

function watcherSandbox(overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-watch-'));
  const root = path.join(base, 'Download');
  const state = path.join(base, 'state');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const config = {
    ...applyDefaults(coreSchema, { watcher: { notify: false, wakeLock: false, ...overrides.watcher } }),
    'downloads-janitor': applyDefaults(janitorSchema, { root })
  };
  return { base, root, state, config, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const write = (root, rel, bytes) => fs.writeFileSync(path.join(root, rel), 'x'.repeat(bytes));

test('the first run adopts existing files instead of announcing all of them', async () => {
  const box = watcherSandbox();
  try {
    write(box.root, 'already-here.jpg', 10);
    write(box.root, 'and-this.pdf', 10);
    const watcher = await createWatcher({ config: box.config, logger: quiet, state: box.state });

    const first = await watcher.poll();
    assert.equal(first.firstRun, true);
    assert.deepEqual(first.events, [], 'an existing folder must not produce 2000 notifications');
    assert.ok(fs.existsSync(watcher.snapshotFile));
    assert.equal(fs.existsSync(watcher.eventsPath), false);
  } finally {
    box.cleanup();
  }
});

test('a file arriving after the baseline is announced once it settles', async () => {
  const box = watcherSandbox();
  try {
    const watcher = await createWatcher({ config: box.config, logger: quiet, state: box.state });
    await watcher.poll(); // baseline

    write(box.root, 'setup.apk', 100);
    const seen = await watcher.poll();
    assert.deepEqual(seen.events, [], 'first sighting only arms the debounce');

    const settled = await watcher.poll();
    assert.equal(settled.events.length, 1);
    assert.equal(settled.events[0].path, 'setup.apk');
    assert.equal(settled.events[0].category, 'apk');

    const again = await watcher.poll();
    assert.deepEqual(again.events, [], 'and it is never announced a second time');

    const queued = fs.readFileSync(watcher.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].acked, false);
  } finally {
    box.cleanup();
  }
});

test('a file still downloading is not announced until its size stops changing', async () => {
  const box = watcherSandbox();
  try {
    const watcher = await createWatcher({ config: box.config, logger: quiet, state: box.state });
    await watcher.poll();

    write(box.root, 'movie.mp4', 100);
    await watcher.poll();
    write(box.root, 'movie.mp4', 5000); // still downloading
    const growing = await watcher.poll();
    assert.deepEqual(growing.events, []);

    const done = await watcher.poll();
    assert.equal(done.events.length, 1);
    assert.equal(done.events[0].size, 5000, 'the announced size is the final one');
  } finally {
    box.cleanup();
  }
});

test('files that arrived while the watcher was dead are detected on the next run', async () => {
  const box = watcherSandbox();
  try {
    const first = await createWatcher({ config: box.config, logger: quiet, state: box.state });
    await first.poll(); // baseline, then the process "dies"

    write(box.root, 'arrived-offline.zip', 50);

    // A brand new watcher object, reading the persisted snapshot from disk.
    const second = await createWatcher({ config: box.config, logger: quiet, state: box.state });
    await second.poll();
    const settled = await second.poll();
    assert.equal(settled.events.length, 1);
    assert.equal(settled.events[0].path, 'arrived-offline.zip');
  } finally {
    box.cleanup();
  }
});

test('auto-rules tag events, and the watcher writes nothing inside Downloads', async () => {
  const box = watcherSandbox({
    watcher: { autoRules: [{ name: 'big-video', match: { category: 'video', largerThanMB: 0.001 } }] }
  });
  try {
    const watcher = await createWatcher({ config: box.config, logger: quiet, state: box.state });
    await watcher.poll();

    write(box.root, 'clip.mp4', 5000);
    await watcher.poll();
    const settled = await watcher.poll();
    assert.equal(settled.events[0].rule, 'big-video');

    // Acceptance criterion 10: read-only by construction.
    const inDownloads = await fsp.readdir(box.root);
    assert.deepEqual(inDownloads.sort(), ['clip.mp4'], 'no snapshot, no trash, no marker files in Downloads');
  } finally {
    box.cleanup();
  }
});

test('the watcher skips the poll instead of crashing when storage is not granted', async () => {
  const box = watcherSandbox();
  try {
    const config = { ...box.config, 'downloads-janitor': { ...box.config['downloads-janitor'], root: '/nonexistent/downloads' } };
    const watcher = await createWatcher({ config, logger: quiet, state: box.state });
    const result = await watcher.poll();
    assert.equal(result.skipped, 'no-storage-grant');
    assert.deepEqual(result.events, []);
  } finally {
    box.cleanup();
  }
});

test('events the watcher writes are readable by the janitor add-on', async () => {
  // The two never talk directly, so the file format is the whole contract between them.
  const box = watcherSandbox();
  try {
    const watcher = await createWatcher({ config: box.config, logger: quiet, state: box.state });
    await watcher.poll();
    write(box.root, 'setup.apk', 100);
    await watcher.poll();
    await watcher.poll();

    const addon = (await import('../src/addons/downloads-janitor/index.mjs')).default;
    const { createFsx } = await import('../src/core/fsx.mjs');
    addon.init({
      config: box.config['downloads-janitor'],
      logger: quiet,
      stateDir: box.state,
      fsx: createFsx({ root: box.root, logger: quiet }),
      createFsx: (r) => createFsx({ root: r, logger: quiet }),
      schema: {}
    });
    const listed = await addon.tools.find((t) => t.name === 'downloads_events').handler({ unackedOnly: true, limit: 50 });
    assert.equal(listed.events.length, 1);
    assert.equal(listed.events[0].path, 'setup.apk');

    const acked = await addon.tools.find((t) => t.name === 'downloads_events_ack').handler({});
    assert.equal(acked.acked, 1);
  } finally {
    box.cleanup();
  }
});
