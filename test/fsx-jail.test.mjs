import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createFsx, TRASH_DIRNAME } from '../src/core/fsx.mjs';
import { Codes } from '../src/core/errors.mjs';

/**
 * Spec acceptance criterion 5: no code path can touch a file outside the root, verified
 * against a hostile-input corpus.
 *
 * These run off-device deliberately. /storage/emulated/0 has no symlink support, so the
 * symlink-escape cases — the ones that actually matter — cannot be constructed there.
 * Testing the jail only on the phone would silently skip them.
 */

function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-jail-'));
  const root = path.join(base, 'Download');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not touch');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'b');
  return { base, root, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function expectEscape(fsx, input, label) {
  assert.throws(
    () => fsx.resolveJailed(input),
    (err) => {
      assert.ok(
        err.code === Codes.PATH_ESCAPE || err.code === Codes.INVALID_INPUT,
        `${label}: expected PATH_ESCAPE/INVALID_INPUT, got ${err.code}: ${err.message}`
      );
      return true;
    },
    `${label} should have been rejected`
  );
}

test('rejects traversal, absolute escapes, and null bytes', () => {
  const box = makeSandbox();
  try {
    const fsx = createFsx({ root: box.root });
    const hostile = [
      '..',
      '../',
      '../outside/secret.txt',
      '../../etc/passwd',
      'sub/../../outside/secret.txt',
      'sub/../../../../../../etc/passwd',
      './../outside/secret.txt',
      '/etc/passwd',
      '/storage/emulated/0/DCIM/photo.jpg',
      box.outside,
      path.join(box.outside, 'secret.txt'),
      'a.txt\0.png',
      '\0',
      ''
    ];
    for (const input of hostile) expectEscape(fsx, input, JSON.stringify(input));
    assert.throws(() => fsx.resolveJailed(null));
    assert.throws(() => fsx.resolveJailed(42));
    assert.throws(() => fsx.resolveJailed(['a.txt']));
  } finally {
    box.cleanup();
  }
});

test('rejects a sibling directory that shares the root as a string prefix', () => {
  const box = makeSandbox();
  try {
    // /…/Download vs /…/Downloads-evil — a naive startsWith() check lets this through.
    const sibling = `${box.root}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'loot.txt'), 'x');
    const fsx = createFsx({ root: box.root });
    expectEscape(fsx, path.join(sibling, 'loot.txt'), 'sibling prefix');
  } finally {
    box.cleanup();
  }
});

test('rejects symlinks that point out of the root', () => {
  const box = makeSandbox();
  try {
    const fsx = createFsx({ root: box.root });

    // A symlinked file inside the root.
    fs.symlinkSync(path.join(box.outside, 'secret.txt'), path.join(box.root, 'link.txt'));
    expectEscape(fsx, 'link.txt', 'symlinked file');

    // A symlinked directory inside the root, reached with a path through it.
    fs.symlinkSync(box.outside, path.join(box.root, 'linkdir'));
    expectEscape(fsx, 'linkdir/secret.txt', 'path through symlinked dir');

    // The important case: the leaf does not exist yet, so a naive existence-based check
    // would skip resolution entirely and allow a write through the escaping directory.
    expectEscape(fsx, 'linkdir/newfile.txt', 'nonexistent leaf under symlinked dir');
    expectEscape(fsx, 'linkdir/deep/nested/new.txt', 'deep nonexistent under symlinked dir');
  } finally {
    box.cleanup();
  }
});

test('accepts legitimate paths and returns absolute resolved paths', () => {
  const box = makeSandbox();
  try {
    const fsx = createFsx({ root: box.root });
    const realRoot = fs.realpathSync(box.root);
    const cases = [
      ['a.txt', path.join(realRoot, 'a.txt')],
      ['./a.txt', path.join(realRoot, 'a.txt')],
      ['sub/b.txt', path.join(realRoot, 'sub', 'b.txt')],
      ['sub/../a.txt', path.join(realRoot, 'a.txt')],
      ['.', realRoot],
      [path.join(box.root, 'a.txt'), path.join(realRoot, 'a.txt')],
      ['not-created-yet.txt', path.join(realRoot, 'not-created-yet.txt')]
    ];
    for (const [input, expected] of cases) {
      assert.equal(fsx.resolveJailed(input), expected, `input ${JSON.stringify(input)}`);
    }
  } finally {
    box.cleanup();
  }
});

test('jails against the resolved root when the root itself is a symlink', () => {
  // This is the real Termux shape: ~/storage/downloads -> /storage/emulated/0/Download.
  const box = makeSandbox();
  try {
    const link = path.join(box.base, 'downloads-link');
    fs.symlinkSync(box.root, link);
    const fsx = createFsx({ root: link });
    const realRoot = fs.realpathSync(box.root);
    assert.equal(fsx.resolveJailed('a.txt'), path.join(realRoot, 'a.txt'));
    expectEscape(fsx, '../outside/secret.txt', 'traversal via symlinked root');
  } finally {
    box.cleanup();
  }
});

test('reports STORAGE_NOT_GRANTED when the root is missing', () => {
  const fsx = createFsx({ root: '/nonexistent/storage/downloads' });
  assert.equal(fsx.rootAvailable(), false);
  assert.throws(
    () => fsx.resolveJailed('a.txt'),
    (err) => {
      assert.equal(err.code, Codes.STORAGE_NOT_GRANTED);
      assert.match(err.message, /termux-setup-storage/);
      return true;
    }
  );
});

test('moves to trash inside the root, with collision suffixes and a .nomedia marker', async () => {
  const box = makeSandbox();
  try {
    const fsx = createFsx({ root: box.root });
    const first = await fsx.atomicMoveToTrash('a.txt');
    assert.ok(fsx.isInTrash(first.to), 'destination must be inside the trash');
    assert.ok(first.to.startsWith(fsx.trashRoot()), 'trash must live inside the root');
    assert.equal(fs.existsSync(path.join(box.root, 'a.txt')), false, 'source is gone');
    assert.ok(fs.existsSync(path.join(fsx.trashRoot(), '.nomedia')), 'MediaStore marker written');

    fs.writeFileSync(path.join(box.root, 'a.txt'), 'a again');
    const second = await fsx.atomicMoveToTrash('a.txt');
    assert.notEqual(second.to, first.to, 'collision must not overwrite');
    assert.match(path.basename(second.to), /^a-1\.txt$/);
  } finally {
    box.cleanup();
  }
});

test('refuses to trash anything outside the root', async () => {
  const box = makeSandbox();
  try {
    const fsx = createFsx({ root: box.root });
    await assert.rejects(() => fsx.atomicMoveToTrash('../outside/secret.txt'));
    await assert.rejects(() => fsx.atomicMoveToTrash(path.join(box.outside, 'secret.txt')));
    assert.equal(fs.readFileSync(path.join(box.outside, 'secret.txt'), 'utf8'), 'do not touch');
  } finally {
    box.cleanup();
  }
});

test('emptyTrash deletes only inside the trash and respects the age cutoff', async () => {
  const box = makeSandbox();
  try {
    const fsx = createFsx({ root: box.root });
    await fsx.atomicMoveToTrash('a.txt');

    // Fresh entry, 7-day cutoff: nothing should go.
    const noop = await fsx.emptyTrash(7);
    assert.equal(noop.deleted, 0, 'recent trash must survive the default retention');

    const dropped = await fsx.emptyTrash(0);
    assert.equal(dropped.deleted, 1);
    assert.ok(dropped.bytes > 0);

    // Everything outside the trash is untouched.
    assert.ok(fs.existsSync(path.join(box.root, 'sub', 'b.txt')));
    assert.ok(fs.existsSync(path.join(box.outside, 'secret.txt')));
  } finally {
    box.cleanup();
  }
});

test('restore moves a file back out of the trash', async () => {
  const box = makeSandbox();
  try {
    const fsx = createFsx({ root: box.root });
    const moved = await fsx.atomicMoveToTrash('sub/b.txt');
    const back = await fsx.restoreFromTrash(moved.to, path.join(box.root, 'sub', 'b.txt'));
    assert.equal(fs.readFileSync(back.to, 'utf8'), 'b');
    assert.equal(fs.existsSync(moved.to), false);
  } finally {
    box.cleanup();
  }
});

test('walk respects depth and never descends into the trash', async () => {
  const box = makeSandbox();
  try {
    const fsx = createFsx({ root: box.root });
    await fsx.atomicMoveToTrash('a.txt');

    const deep = path.join(box.root, 'l1', 'l2', 'l3', 'l4');
    await fsp.mkdir(deep, { recursive: true });
    await fsp.writeFile(path.join(box.root, 'l1', 'd1.txt'), 'x');
    await fsp.writeFile(path.join(deep, 'too-deep.txt'), 'x');

    const files = await fsx.walk({ maxDepth: 3 });
    const rels = files.map((f) => f.rel);
    assert.ok(rels.includes(path.join('sub', 'b.txt')));
    assert.ok(rels.includes(path.join('l1', 'd1.txt')));
    assert.ok(!rels.some((r) => r.startsWith(TRASH_DIRNAME)), 'trash must be skipped');
    assert.ok(!rels.some((r) => r.includes('too-deep')), 'depth limit must hold');
  } finally {
    box.cleanup();
  }
});
