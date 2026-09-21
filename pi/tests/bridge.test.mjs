import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { rpc, createBridge } from '../bridge.mjs';

const model = {
  id: 'gpt-test',
  api: 'secure-codex',
  provider: 'secure-codex',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = {
  systemPrompt: 'system',
  messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
  tools: [],
};
const completed = {
  id: 'resp',
  status: 'completed',
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  output: [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'OK 你好', annotations: [] }],
    },
  ],
};

async function serve(handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-rpc-'));
  const socketPath = path.join(directory, 'api.sock');
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('\n')) handler(JSON.parse(buffer), socket);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    close: async () => {
      server.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test('rpc reassembles UTF-8 frames split mid-character and bounds oversized replies', async () => {
  const reply = Buffer.from(JSON.stringify({ ok: true, result: { text: '你好世界' } }) + '\n');
  const { socketPath, close } = await serve((request, socket) => {
    if (request.op === 'split') {
      socket.write(reply.subarray(0, 25)); // cuts inside a 3-byte character
      setTimeout(() => socket.write(reply.subarray(25)), 10);
    } else if (request.op === 'huge') {
      socket.write(Buffer.alloc(70000, 0x61));
    } else {
      socket.end(JSON.stringify({ ok: false, error: 'APPROVAL_REQUIRED:abc' }) + '\n');
    }
  });
  try {
    assert.deepEqual(await rpc(socketPath, { op: 'split' }), { text: '你好世界' });
    await assert.rejects(rpc(socketPath, { op: 'huge' }), /RESPONSE_TOO_LARGE/);
    await assert.rejects(rpc(socketPath, { op: 'deny' }), /APPROVAL_REQUIRED:abc/);
    await assert.rejects(
      rpc(socketPath, { op: 'x', text: 'y'.repeat(70000) }),
      /REQUEST_TOO_LARGE/,
    );
  } finally {
    await close();
  }
});

test('bridge waits for one approval notification, then resumes the identical request', async () => {
  const calls = [],
    events = [],
    waits = [];
  const call = async (socket, request) => {
    calls.push(request);
    if (calls.length < 3) throw new Error('APPROVAL_REQUIRED:approval-1');
    return completed;
  };
  const bridge = createBridge({
    notify: (e) => events.push(e),
    call,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  const message = await bridge(model, context, {}).result();
  assert.equal(message.stopReason, 'stop');
  assert.equal(message.content.find((c) => c.type === 'text').text, 'OK 你好');
  assert.equal(events.length, 1);
  assert.equal(events[0].approval_id, 'approval-1');
  assert.equal(events[0].request_id, calls[0].request_id);
  assert.equal(
    new Set(calls.map((c) => c.request_id)).size,
    1,
    'retries must reuse the request id',
  );
  assert.equal(calls[0].instructions, 'system');
  assert.equal(calls[0].tools.length, 0);
  assert.deepEqual(waits, [3000, 3000]);
});

test('bridge enforces the per-turn call budget and surfaces gateway errors without retrying', async () => {
  let attempts = 0;
  const call = async () => {
    attempts++;
    throw new Error('CODEX_CONTEXT_TOO_LARGE');
  };
  const bridge = createBridge({ maxCalls: 1, call, wait: async () => {} });
  const first = await bridge(model, context, {}).result();
  assert.equal(first.stopReason, 'error');
  assert.equal(first.errorMessage, 'CODEX_CONTEXT_TOO_LARGE');
  assert.equal(attempts, 1);
  const second = await bridge(model, context, {}).result();
  assert.equal(second.errorMessage, 'PI_TURN_LIMIT');
  assert.equal(attempts, 1);
  bridge.resetBudget();
  await bridge(model, context, {}).result();
  assert.equal(attempts, 2);
});

test('bridge gives up after the approval deadline instead of polling forever', async () => {
  const call = async () => {
    throw new Error('APPROVAL_REQUIRED:slow');
  };
  const bridge = createBridge({ call, wait: async () => {}, approvalWaitMs: -1 });
  const message = await bridge(model, context, {}).result();
  assert.equal(message.errorMessage, 'APPROVAL_WAIT_TIMEOUT');
});
