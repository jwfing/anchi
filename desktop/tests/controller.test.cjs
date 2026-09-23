const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Controller, validateHostCommand } = require('../src/main/controller.cjs');
const id = 'a'.repeat(32),
  digest = 'b'.repeat(64);
function fixture(confirm = true, overrides = {}) {
  const calls = [];
  const runtime = {
    root: '/runtime',
    async policy(...args) {
      calls.push(args);
      return args[0] === 'show' ? { id, digest, state: 'PENDING', ...overrides } : { ok: true };
    },
  };
  const controller = new Controller({
    runtime,
    directories: { directories: [] },
    pi: { state: {} },
    notify() {},
    dialogs: {
      async confirmApproval() {
        return confirm;
      },
    },
  });
  return { controller, calls };
}
test('renderer cannot invent operations or smuggle extra fields', () => {
  for (const op of ['exec', '__proto__', 'toString']) assert.throws(() => validateHostCommand(op));
  for (const args of [null, [], { command: 'sh' }])
    assert.throws(() => validateHostCommand('snapshot', args));
});
test('approval uses fresh trusted detail and exact digest after explicit confirmation', async () => {
  const { controller, calls } = fixture();
  await controller.dispatch('approval-decide', { id, digest, decision: 'approve' });
  assert.deepEqual(calls, [
    ['show', id],
    ['approve', id, '--digest', digest],
  ]);
});
test('mismatched or consumed approval never reaches decision', async () => {
  for (const overrides of [{ digest: 'changed' }, { state: 'CONSUMED' }]) {
    const { controller, calls } = fixture(true, overrides);
    await assert.rejects(
      controller.dispatch('approval-decide', { id, digest, decision: 'approve' }),
      /APPROVAL_CHANGED/,
    );
    assert.equal(calls.length, 1);
  }
});
test('native cancel makes no policy mutation', async () => {
  const { controller, calls } = fixture(false);
  assert.deepEqual(
    await controller.dispatch('approval-decide', { id, digest, decision: 'approve' }),
    { cancelled: true },
  );
  assert.equal(calls.length, 1);
});
test('overlapping native mutation is rejected until dialog resolves', async () => {
  let finish;
  const { controller } = fixture();
  controller.dialogs.chooseDirectory = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = controller.dispatch('directories-add', { mode: 'ro' });
  await assert.rejects(
    controller.dispatch('directories-add', { mode: 'rw' }),
    /ACTION_IN_PROGRESS/,
  );
  finish(null);
  await first;
  assert.equal(controller.mutating, false);
});

test('first task completion requires reply and finish from the same recorded turn', async () => {
  const { controller } = fixture();
  const calls = [];
  let completed = 0;
  controller.pi = {
    state: { connected: true, busy: false },
    sessionId: 'session',
    async request(op, args) {
      calls.push({ op, args });
      return { turn_id: 'turn' };
    },
  };
  controller.setup = {
    completed: async () => {
      completed++;
    },
  };
  await controller.dispatch('first-task');
  assert.deepEqual(
    calls.map((c) => c.op),
    ['new', 'prompt'],
  );
  controller.emit({ type: 'finished', turn_id: 'other', session_id: 'session', success: true });
  assert.equal(controller.firstTask.state, 'running');
  controller.emit({
    type: 'assistant',
    turn_id: 'turn',
    session_id: 'session',
    text: 'synthetic result',
  });
  controller.emit({ type: 'finished', turn_id: 'turn', session_id: 'session', success: true });
  assert.equal(controller.firstTask.state, 'succeeded');
  assert.equal(completed, 1);
  assert(!calls.some((c) => c.op === 'approve'));
});
test('credential refresh is allowed while Pi stays connected; rebuilds are not', async () => {
  const { controller } = fixture();
  const started = [];
  controller.pi = { state: {}, child: {} };
  controller.setup = { busy: false, start: async (action) => started.push(action) };
  controller.dialogs.confirmSetup = async () => true;
  for (const action of ['import', 'login', 'unlock'])
    await controller.dispatch('setup-start', { action });
  for (const action of ['install', 'dependencies'])
    await assert.rejects(controller.dispatch('setup-start', { action }), /DISCONNECT_PI_FIRST/);
  assert.deepEqual(started, ['import', 'login', 'unlock']);
});
test('audit passes through to the trusted policy admin and snapshot exposes restore reasons', async () => {
  const { controller, calls } = fixture();
  await controller.dispatch('audit');
  assert.deepEqual(calls.at(-1), ['audit', '--limit', '200']);
  controller.directories = { directories: [{ id: 'a', path: '/x', mode: 'ro' }] };
  controller.files = { grants: new Map(), restoreErrors: new Map([['a', 'DIRECTORY_CHANGED']]) };
  assert.equal(controller.snapshot().directories[0].reason, 'DIRECTORY_CHANGED');
  assert.equal(controller.snapshot().directories[0].status, 'pending');
  assert.equal(controller.snapshot().limits.prompt_chars, 8000);
});
test('setup blocks guest mutations and native decline never runs installers', async () => {
  const { controller } = fixture();
  controller.setup = { busy: true };
  await assert.rejects(controller.dispatch('connect'), /SETUP_IN_PROGRESS/);
  controller.setup = {
    busy: false,
    start: () => {
      throw Error('MUST_NOT_RUN');
    },
  };
  controller.dialogs.confirmSetup = async () => false;
  assert.deepEqual(await controller.dispatch('setup-start', { action: 'install' }), {
    cancelled: true,
  });
});

test('connector operations route to the right trusted CLI with the connector argument', async () => {
  const { controller } = fixture();
  const calls = [];
  controller.runtime.auth = async (action, value, connector) => {
    calls.push(['auth', action, connector]);
    return { drive: { connected: true } };
  };
  controller.runtime.connectorAdmin = async (connector, action) => {
    calls.push(['admin', connector, action]);
    return { connector, connected: false, remote_revoked: true };
  };
  controller.runtime.policy = async (...args) => {
    calls.push(['policy', ...args]);
    if (args[0] === 'rules') return { rules: { slack: 'ask' } };
    return {};
  };
  controller.oauth = {
    status: async () => ({}),
    begin: async (c) => {
      calls.push(['begin', c]);
      return { pending: true };
    },
    cancel: async () => {},
  };
  controller.tokens = { prompt: async (d) => (d.id === 'slack' ? 'xoxb-' + '1'.repeat(40) : null) };
  controller.dialogs.confirmStanding = async () => true;
  controller.dialogs.confirmDisconnect = async () => true;
  controller.pi = { state: {}, disconnect: async () => {} };
  await controller.dispatch('connector-connect', { connector: 'drive' });
  await controller.dispatch('connector-import-token', { connector: 'slack' });
  assert.deepEqual(await controller.dispatch('connector-import-token', { connector: 'notion' }), {
    cancelled: true,
  });
  await controller.dispatch('connector-read', { connector: 'notion', mode: 'allow' });
  await controller.dispatch('connector-mode', { connector: 'notion', mode: 'ask' });
  await controller.dispatch('model-mode', { mode: 'ask' });
  await controller.dispatch('rules');
  await controller.dispatch('connector-disconnect', { connector: 'slack' });
  assert.deepEqual(calls, [
    ['begin', 'drive'],
    ['auth', 'import-token', 'slack'],
    ['admin', 'slack', 'probe'],
    ['policy', 'mode', 'notion', 'auto'],
    ['policy', 'mode', 'notion', 'ask'],
    ['policy', 'mode', 'inference', 'ask'],
    ['policy', 'rules'],
    ['policy', 'rules'],
    ['policy', 'mode', 'slack', 'ask'],
    ['admin', 'slack', 'disconnect'],
  ]);
  // Restoring standing authorization always goes through the explicit warning dialog.
  controller.dialogs.confirmStanding = async () => false;
  assert.deepEqual(await controller.dispatch('model-mode', { mode: 'auto' }), { cancelled: true });
  assert.deepEqual(
    await controller.dispatch('connector-mode', { connector: 'drive', mode: 'auto' }),
    {
      cancelled: true,
    },
  );
  controller.dialogs.confirmStanding = async () => true;
  await assert.rejects(
    controller.dispatch('connector-import-token', { connector: 'drive' }),
    /TOKEN_NOT_APPLICABLE/,
  );
  await assert.rejects(
    controller.dispatch('connector-connect', { connector: 'slack' }),
    /OAUTH_NOT_APPLICABLE/,
  );
  // The Gmail aliases keep working and the imported token never reaches the activity log.
  calls.length = 0;
  await controller.dispatch('gmail-read', { mode: 'deny' });
  assert.deepEqual(calls, [['policy', 'mode', 'gmail', 'ask']]);
  assert(!JSON.stringify(controller.events).includes('xoxb-'));
});

test('live activity, notifications and persisted events share a timestamp', () => {
  const { controller } = fixture();
  const written = [],
    notified = [];
  controller.log = {
    append(event) {
      written.push(event);
      return Promise.resolve();
    },
  };
  controller.notify = (event) => notified.push(event);
  const input = { type: 'tool_start', tool: 'bash' };
  controller.emit(input);
  const event = controller.events.at(-1);
  assert(Number.isFinite(Date.parse(event.time)));
  assert.equal(written[0].time, event.time);
  assert.equal(notified[0].time, event.time);
  assert.equal(input.time, undefined);
  controller.emit({ type: 'ready', time: '2026-09-21T12:00:00Z' });
  assert.equal(controller.events.at(-1).time, '2026-09-21T12:00:00Z');
});
