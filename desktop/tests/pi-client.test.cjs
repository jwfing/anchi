const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { PiClient } = require('../src/main/pi-client.cjs');
function fixture(options = {}) {
  const process = new EventEmitter(),
    commands = [],
    events = [],
    kills = [];
  Object.assign(process, {
    exitCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill(signal) {
      kills.push(signal);
      if (signal === 'SIGKILL') this.emit('close', 1);
    },
  });
  process.stdin = new Writable({
    write(bytes, _encoding, callback) {
      commands.push(JSON.parse(bytes.toString()));
      callback();
    },
  });
  const client = new PiClient({
    runtime: { root: '/runtime', env: {} },
    notify: (e) => events.push(e),
    spawnProcess: () => process,
    responseTimeout: 50,
    startupTimeout: 1000,
    stopTimeout: 5,
    ...options,
  });
  const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  client.connect();
  emit({ type: 'ready', protocol_version: 1, session_id: 'test-session' });
  return { client, process, commands, events, emit, kills };
}
test('request correlation rejects unsolicited responses and preserves completion state', async () => {
  const { client, emit, commands, process } = fixture();
  emit({
    type: 'response',
    id: 'fake',
    op: 'prompt',
    ok: true,
    result: { busy: true, session_id: 'fake' },
  });
  assert.equal(client.busy, false);
  assert.equal(client.sessionId, 'test-session');
  const prompt = client.request('prompt', { text: 'test' });
  emit({ type: 'response', id: commands[0].id, op: 'prompt', ok: true, result: { busy: true } });
  emit({ type: 'finished', success: true });
  await prompt;
  assert.equal(client.busy, false);
  process.emit('close', 0);
});
test('pending requests reject on transport closure', async () => {
  const { client, process } = fixture();
  const request = client.request('status');
  process.emit('close', 1);
  await assert.rejects(request, /PI_DISCONNECTED/);
  assert.equal(client.ready, false);
});
test('request timeout releases pending slot', async () => {
  const { client, process } = fixture({ responseTimeout: 5 });
  await assert.rejects(client.request('status'), /PI_RESPONSE_TIMEOUT/);
  assert.equal(client.pending.size, 0);
  process.emit('close', 0);
});
test('disconnect closes stdin and escalates termination if child ignores EOF', async () => {
  const { client, process, kills } = fixture();
  await client.disconnect();
  assert.equal(process.stdin.writableEnded, true);
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(client.child, null);
});
