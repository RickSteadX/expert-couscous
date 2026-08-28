import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validate, applyDefaults } from '../src/core/schema.mjs';
import { loadConfig, ConfigError, coreSchema } from '../src/core/config.mjs';
import { discoverAddons, collectSchemas, initAddons } from '../src/core/addon-loader.mjs';

const quietLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => quietLogger };

test('schema validator accepts valid input and reports readable errors', () => {
  const schema = {
    type: 'object',
    properties: {
      dryRun: { type: 'boolean', default: true },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      category: { type: 'string', enum: ['images', 'video', 'apk'] }
    },
    required: ['limit'],
    additionalProperties: false
  };
  assert.deepEqual(validate(schema, { limit: 10, dryRun: false }), []);
  assert.deepEqual(validate(schema, {}), ["value: missing required property 'limit'"]);
  assert.match(validate(schema, { limit: 0 })[0], /must be >= 1/);
  assert.match(validate(schema, { limit: 'ten' })[0], /expected integer, got string/);
  assert.match(validate(schema, { limit: 1, category: 'nope' })[0], /must be one of/);
  assert.match(validate(schema, { limit: 1, wat: 1 })[0], /unknown property 'wat'/);
});

test('applyDefaults fills dryRun as true when omitted', () => {
  // This is a safety property, not a convenience: an omitted dryRun must never reach a
  // handler as undefined, or a falsy check would turn a dry run into a real delete.
  const schema = { type: 'object', properties: { dryRun: { type: 'boolean', default: true } } };
  assert.equal(applyDefaults(schema, {}).dryRun, true);
  assert.equal(applyDefaults(schema, { dryRun: false }).dryRun, false);
  assert.equal(applyDefaults(schema, undefined).dryRun, true);
});

function withConfigFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('config merges defaults, honours user values, and rejects invalid ones', () => {
  const defaults = loadConfig({ file: '/nonexistent/config.json', env: {} });
  assert.equal(defaults.log.level, 'info');
  assert.equal(defaults.watcher.pollSeconds, 30);
  assert.deepEqual(defaults.disabledAddons, []);
  assert.ok(defaults.log.file.endsWith('janitor.log'));

  withConfigFile({ log: { level: 'debug' }, watcher: { pollSeconds: 60 } }, (file) => {
    const cfg = loadConfig({ file, env: {} });
    assert.equal(cfg.log.level, 'debug');
    assert.equal(cfg.watcher.pollSeconds, 60);
    assert.equal(cfg.watcher.notify, true, 'untouched keys keep their defaults');
  });

  withConfigFile({ log: { level: 'shout' } }, (file) => {
    assert.throws(() => loadConfig({ file, env: {} }), ConfigError);
  });
  withConfigFile('{not json', (file) => {
    assert.throws(() => loadConfig({ file, env: {} }), /not valid JSON/);
  });
  withConfigFile({ watcher: { pollSeconds: 2 } }, (file) => {
    assert.throws(() => loadConfig({ file, env: {} }), /must be >= 5/);
  });
});

test('env overrides win over the config file and are coerced to the right type', () => {
  withConfigFile({ log: { level: 'info' }, watcher: { pollSeconds: 30 } }, (file) => {
    const cfg = loadConfig({
      file,
      env: { JANITOR_LOG_LEVEL: 'debug', JANITOR_WATCHER_POLL_SECONDS: '90', JANITOR_WATCHER_NOTIFY: 'false' }
    });
    assert.equal(cfg.log.level, 'debug');
    assert.equal(cfg.watcher.pollSeconds, 90, 'numeric env var must not stay a string');
    assert.equal(cfg.watcher.notify, false, 'boolean env var must not stay a string');
  });
});

test('config validates add-on sections against their own schemas', () => {
  const addonSchemas = {
    'downloads-janitor': {
      type: 'object',
      properties: {
        root: { type: 'string', default: '~/storage/downloads' },
        maxBatchFiles: { type: 'integer', minimum: 1, default: 500 }
      }
    }
  };
  withConfigFile({}, (file) => {
    const cfg = loadConfig({ file, env: {}, addonSchemas });
    assert.equal(cfg['downloads-janitor'].root, '~/storage/downloads');
    assert.equal(cfg['downloads-janitor'].maxBatchFiles, 500);
  });
  withConfigFile({ 'downloads-janitor': { maxBatchFiles: 0 } }, (file) => {
    assert.throws(() => loadConfig({ file, env: {}, addonSchemas }), /maxBatchFiles: must be >= 1/);
  });
});

test('coreSchema itself is a well-formed schema for an empty object', () => {
  assert.deepEqual(validate(coreSchema, applyDefaults(coreSchema, {})), []);
});

// --- add-on loader ------------------------------------------------------------

function withAddonDir(addons, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-addons-'));
  for (const [name, source] of Object.entries(addons)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'index.mjs'), source);
  }
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const goodAddon = (name, tool) => `
export default {
  name: ${JSON.stringify(name)},
  version: '1.0.0',
  configSchema: { type: 'object', properties: { enabled: { type: 'boolean', default: true } } },
  init() {},
  tools: [{
    name: ${JSON.stringify(tool)},
    description: 'does a thing',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ ok: true })
  }]
};
`;

test('loader registers valid add-ons and skips broken ones without crashing', async () => {
  await withAddonDir(
    {
      'good-one': goodAddon('good-one', 'good_tool'),
      'bad-manifest': 'export default { name: 123 };',
      'throws-on-import': 'throw new Error("boom");',
      'no-tools': "export default { name: 'no-tools', version: '1.0.0' };",
      'name-mismatch': goodAddon('something-else', 'other_tool')
    },
    async (dir) => {
      const discovered = await discoverAddons({ dir, logger: quietLogger });
      assert.deepEqual(discovered.map((d) => d.manifest.name), ['good-one']);

      const { tools, loaded } = await initAddons({
        discovered,
        config: { disabledAddons: [] },
        logger: quietLogger,
        makeContext: () => ({})
      });
      assert.deepEqual(loaded, ['good-one']);
      assert.deepEqual([...tools.keys()], ['good_tool']);
    }
  );
});

test('loader honours disabledAddons and refuses duplicate tool names', async () => {
  await withAddonDir(
    { 'addon-a': goodAddon('addon-a', 'shared_tool'), 'addon-b': goodAddon('addon-b', 'shared_tool') },
    async (dir) => {
      const discovered = await discoverAddons({ dir, logger: quietLogger });
      assert.equal(discovered.length, 2);

      const dup = await initAddons({
        discovered,
        config: { disabledAddons: [] },
        logger: quietLogger,
        makeContext: () => ({})
      });
      assert.deepEqual(dup.loaded, ['addon-a'], 'second add-on must not shadow the first');
      assert.deepEqual(dup.skipped, ['addon-b']);

      const off = await initAddons({
        discovered,
        config: { disabledAddons: ['addon-a'] },
        logger: quietLogger,
        makeContext: () => ({})
      });
      assert.deepEqual(off.loaded, ['addon-b']);
    }
  );
});

test('loader skips an add-on whose config section fails its own schema', async () => {
  await withAddonDir({ 'strict-addon': goodAddon('strict-addon', 'strict_tool') }, async (dir) => {
    const discovered = await discoverAddons({ dir, logger: quietLogger });
    assert.deepEqual(collectSchemas(discovered)['strict-addon'].type, 'object');

    const { loaded, skipped } = await initAddons({
      discovered,
      config: { disabledAddons: [], 'strict-addon': { enabled: 'yes please' } },
      logger: quietLogger,
      makeContext: () => ({})
    });
    assert.deepEqual(loaded, []);
    assert.deepEqual(skipped, ['strict-addon']);
  });
});
