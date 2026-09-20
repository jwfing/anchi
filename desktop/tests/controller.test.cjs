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
