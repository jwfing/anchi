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

test('approval detail renders a structured summary from the trusted action and keeps raw JSON', async () => {
  const { renderPage, approvalSummary } = await import('../src/renderer/views.mjs');
  const action = {
    operation: 'inference.codex',
    account: 'gen-1',
    params: {
      model: 'gpt-test',
      instructions: 'x'.repeat(120),
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'first' }] },
        { type: 'function_call', call_id: 'c', name: 'bash', arguments: '{}' },
        { role: 'user', content: [{ type: 'input_text', text: '<b>latest</b> question' }] },
      ],
      tools: [
        { type: 'function', name: 'read' },
        { type: 'function', name: 'host_files' },
      ],
    },
  };
  const rows = Object.fromEntries(approvalSummary(action));
  assert.equal(rows['模型'], 'gpt-test');
  assert.equal(rows['上下文条目'], '3 条');
  assert.equal(rows['最近用户输入'], '<b>latest</b> question');
  assert.equal(rows['模型可调用工具'], 'read, host_files');
  const html = renderPage({
    page: 'approvals',
    state: { directories: [], events: [] },
    messages: [],
    approvals: [],
    approvalsLoaded: true,
    detail: { id: 'id', state: 'PENDING', digest: 'd', expires: 1, action },
  });
  assert(html.includes('&lt;b&gt;latest&lt;/b&gt;'));
  assert(!html.includes('<b>latest</b>'));
  assert(html.includes('<details>'));
  assert(html.includes('data-act="approve"'));
  assert.deepEqual(approvalSummary(null), []);
});
test('permissions page explains restore failures and Gmail re-authentication', async () => {
  const { renderPage } = await import('../src/renderer/views.mjs');
  const html = renderPage({
    page: 'permissions',
    state: {
      directories: [
        {
          id: 'a',
          path: '/Users/x/docs',
          mode: 'ro',
          status: 'pending',
          reason: 'DIRECTORY_CHANGED',
        },
        { id: 'b', path: '/Users/x/out', mode: 'rw', status: 'active', reason: null },
      ],
      events: [],
      gmail: { connected: true, reauth_required: true, vault_unlocked: true },
    },
    messages: [],
    approvals: [],
  });
  assert(html.includes('目录已变化，需重新确认'));
  assert(html.includes('重新确认'));
  assert(html.includes('已授权'));
  assert(html.includes('需要重新认证'));
});
