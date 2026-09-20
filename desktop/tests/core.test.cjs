const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateCommand, overlaps, Lines } = require('../src/shared/protocol.cjs');
test('RPC boundary rejects arbitrary operations, paths and extra fields', () => {
  for (const op of ['approve', 'exec', '__proto__', 'toString'])
    assert.throws(() => validateCommand(op));
  assert.throws(() => validateCommand('prompt', { text: 'hello', endpoint: 'https://evil' }));
  assert.throws(() => validateCommand('resume', { session_id: '../../secret' }));
  assert.throws(() => validateCommand('prompt', { text: 'x'.repeat(8001) }));
  assert.deepEqual(validateCommand('prompt', { text: 'hello' }), { op: 'prompt', text: 'hello' });
});
test('directory ancestry rejects overlapping roots, allows sibling prefixes', () => {
  assert.equal(overlaps('/Users/a/docs', '/Users/a/docs/sub'), true);
  assert.equal(overlaps('/', '/Users/a'), true);
  assert.equal(overlaps('/Users/a/docs', '/Users/a/docs-other'), false);
});
test('agent output handles UTF8 chunks and bounds untrusted frames', () => {
  const got = [],
    errors = [];
  const lines = new Lines(
    (x) => got.push(x),
    (e) => errors.push(e),
  );
  const data = Buffer.from(JSON.stringify({ text: '你好' }) + '\n');
  for (const byte of data) lines.push(Buffer.from([byte]));
  assert.deepEqual(got, [{ text: '你好' }]);
  assert.equal(errors.length, 0);
  lines.push(Buffer.alloc(65537, 97));
  assert.equal(errors.length, 1);
  lines.push(Buffer.from('{}\n'));
  assert.equal(got.length, 1);
});
