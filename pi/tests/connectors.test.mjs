import test from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTOR_TOOLS, connectedConnectors, ALL_TOOL_NAMES } from '../connectors.mjs';

test('tool catalog matches the registry operations and stays small', () => {
  assert.deepEqual(Object.keys(CONNECTOR_TOOLS).sort(), ['drive', 'gmail', 'notion', 'slack']);
  const names = Object.values(CONNECTOR_TOOLS)
    .flat()
    .map((t) => t.name);
  assert.deepEqual([...new Set(names)].sort(), [...names].sort());
  for (const name of [
    'drive_search',
    'drive_read',
    'drive_create',
    'drive_update',
    'notion_search',
    'notion_read',
    'notion_create_page',
    'notion_append',
    'slack_channels',
    'slack_history',
    'slack_post',
    'gmail_status',
    'gmail_list',
    'gmail_read',
  ])
    assert(names.includes(name), name);
  assert.deepEqual([...ALL_TOOL_NAMES].sort(), [...names].sort());
  const size = Buffer.byteLength(
    JSON.stringify(
      Object.values(CONNECTOR_TOOLS)
        .flat()
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    ),
  );
  assert(size <= 8192, `tool schemas are ${size} bytes`);
  for (const tool of Object.values(CONNECTOR_TOOLS).flat())
    if (/_(create|update|append|post|create_page)$/.test(tool.name))
      assert.match(tool.description, /审批/);
});

test('request builders add a fresh request_id for writes and never accept extra fields', () => {
  const post = CONNECTOR_TOOLS.slack.find((t) => t.name === 'slack_post');
  const request = post.request({ channel: 'C1', text: 'hi', evil: 'x' });
  assert.equal(request.op, 'post');
  assert.match(request.request_id, /^[0-9a-f]{32}$/);
  assert.equal(request.evil, undefined);
  assert.notEqual(post.request({ channel: 'C1', text: 'hi' }).request_id, request.request_id);
  const list = CONNECTOR_TOOLS.gmail.find((t) => t.name === 'gmail_list');
  assert.deepEqual(list.request({ query: 'q', limit: 2 }), { op: 'list', query: 'q', limit: 2 });
});

test('only connected connectors are registered', async () => {
  const statuses = {
    '/run/secure-gmail/api.sock': { connected: true },
    '/run/secure-drive/api.sock': { connected: false },
  };
  const rpc = async (path) => {
    if (!(path in statuses)) throw new Error('GATEWAY_UNAVAILABLE');
    return statuses[path];
  };
  assert.deepEqual(await connectedConnectors(rpc), ['gmail']);
});
