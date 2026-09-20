const { test } = require('node:test');
const assert = require('node:assert/strict');

test('untrusted agent and approval text cannot create executable controls', async () => {
  const { renderPage } = await import('../src/renderer/views.mjs');
  const input = '<img src=x onerror=alert(1)><button data-act="approve">fake</button>';
  const props = {
    state: { connected: true, directories: [], events: [] },
    env: 'running',
    messages: [{ role: 'assistant', text: input }],
    draft: input,
    approvals: [],
    detail: null,
  };
  const chat = renderPage({ ...props, page: 'agent' });
  assert.equal(typeof chat, 'string');
  assert(!chat.includes('<img'));
  assert(chat.includes('&lt;img'));
  assert(!chat.includes('data-act="approve"'));
  const approval = renderPage({
    ...props,
    page: 'approvals',
    detail: { id: 'test', state: 'CONSUMED', digest: 'x', action: { text: input } },
  });
  assert(!approval.includes('<img'));
  assert(!approval.includes('data-act="approve"'));
});

test('all views render and an empty refreshed list differs from not loaded', async () => {
  const { renderPage } = await import('../src/renderer/views.mjs');
  const props = { state: { directories: [], events: [] }, messages: [], approvals: [] };
  for (const page of ['setup', 'agent', 'permissions', 'approvals', 'activity'])
    assert.match(renderPage({ ...props, page }), /<h1>/);
  assert.match(renderPage({ ...props, page: 'approvals', approvalsLoaded: false }), /尚未载入/);
  assert.match(renderPage({ ...props, page: 'approvals', approvalsLoaded: true }), /已刷新/);
});
