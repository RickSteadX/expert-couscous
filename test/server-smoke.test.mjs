import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

/**
 * Spec §9 step 10: run the server and confirm it answers a piped `initialize` request.
 * This also guards the rule from §4 that nothing but JSON-RPC may reach stdout — the
 * failure mode that rule prevents is silent and looks nothing like its cause.
 */
function startServer(env = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-state-'));
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JANITOR_CONFIG: path.join(stateDir, 'config.json'), // absent: pure defaults
      JANITOR_STATE_DIR: stateDir,
      ...env
    }
  });

  let stdout = '';
  let stderr = '';
  const lines = [];
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let idx;
    while ((idx = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, idx).trim();
      stdout = stdout.slice(idx + 1);
      if (!line) continue;
      if (waiters.length) waiters.shift()(line);
      else lines.push(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  return {
    child,
    send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
    nextLine: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for a frame; stderr:\n${stderr}`)), 15000);
        const settle = (line) => { clearTimeout(timer); resolve(line); };
        if (lines.length) settle(lines.shift());
        else waiters.push(settle);
      }),
    get stderr() { return stderr; },
    stop: () => {
      child.kill('SIGTERM');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  };
}

test('responds to initialize and tools/list over stdio', async () => {
  const server = startServer();
  try {
    server.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0.0.0' }
      }
    });

    const initLine = await server.nextLine();
    const init = JSON.parse(initLine);
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.id, 1);
    assert.equal(init.result.serverInfo.name, 'janitor-mcp');
    assert.ok(init.result.capabilities.tools, 'server must advertise the tools capability');

    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    const listed = JSON.parse(await server.nextLine());
    assert.equal(listed.id, 2);
    assert.ok(Array.isArray(listed.result.tools), 'tools/list must return an array');

    // The bundled downloads-janitor add-on must be mounted end-to-end, with every tool
    // carrying the JSON Schema the model needs to call it.
    const names = listed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'downloads_clean',
      'downloads_dedupe',
      'downloads_empty_trash',
      'downloads_events',
      'downloads_events_ack',
      'downloads_list',
      'downloads_scan',
      'downloads_undo',
      'watcher_status'
    ]);
    for (const t of listed.result.tools) {
      assert.equal(t.inputSchema.type, 'object', `${t.name} must declare an object inputSchema`);
      assert.ok(t.description.length > 0, `${t.name} must have a description`);
    }
  } finally {
    server.stop();
  }
});

test('logs go to stderr, never stdout', async () => {
  const server = startServer({ JANITOR_LOG_LEVEL: 'debug' });
  try {
    server.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    });
    const line = await server.nextLine();
    assert.doesNotThrow(() => JSON.parse(line), 'every stdout line must be parseable JSON-RPC');
    assert.match(server.stderr, /starting/, 'startup log must appear on stderr');
    assert.ok(!line.includes('starting'), 'log text must never leak into the JSON-RPC stream');
  } finally {
    server.stop();
  }
});

test('an unknown tool returns a coded error result, not a crash', async () => {
  const server = startServer();
  try {
    server.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    });
    await server.nextLine();
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    server.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } });

    const res = JSON.parse(await server.nextLine());
    assert.equal(res.id, 3);
    assert.equal(res.result.isError, true);
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.code, 'UNKNOWN_TOOL');
    assert.match(payload.message, /No such tool/);
  } finally {
    server.stop();
  }
});

test('a real tool call without the storage grant returns an actionable error', async () => {
  const server = startServer({ JANITOR__DOWNLOADS_JANITOR__ROOT: '/nonexistent/storage/downloads' });
  try {
    server.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    });
    await server.nextLine();
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    server.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'downloads_scan', arguments: {} } });

    const res = JSON.parse(await server.nextLine());
    assert.equal(res.result.isError, true);
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.code, 'STORAGE_NOT_GRANTED');
    assert.match(payload.message, /termux-setup-storage/);
    // Names the configured root, which also proves the env override reached the add-on's
    // config section rather than the tool merely failing on the default.
    assert.match(payload.message, /\/nonexistent\/storage\/downloads/);
  } finally {
    server.stop();
  }
});

test('an invalid config file exits with EX_CONFIG (78)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-badcfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ log: { level: 'shout' } }));
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, JANITOR_CONFIG: file, JANITOR_STATE_DIR: dir }
      });
      child.on('exit', resolve);
    });
    assert.equal(code, 78);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
