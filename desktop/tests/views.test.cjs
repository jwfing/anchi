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
      connectorCatalog: require('../src/shared/connectors.cjs').CONNECTORS,
      connectors: {
        gmail: { connected: true, reauth_required: true, auth: 'google' },
        vault_unlocked: true,
      },
    },
    messages: [],
    approvals: [],
  });
  assert(html.includes('目录已变化，需重新确认'));
  assert(html.includes('重新确认'));
  assert(html.includes('已授权'));
  assert(html.includes('需要重新认证'));
});

test('setup step 1 shows Linux manual root commands and no Homebrew wording', async () => {
  const { renderPage } = await import('../src/renderer/views.mjs');
  const health = {
    supported: true,
    platform: 'linux-x64',
    brew: false,
    lima: false,
    python: true,
    codex: false,
    qemu: false,
    kvm: false,
    freeGiB: 30,
    vm: 'missing',
    installed: false,
    unlocked: false,
    configured: false,
    manualSteps: [
      'sudo apt-get install -y qemu-system-x86 qemu-utils',
      'sudo usermod -aG kvm "$USER"',
    ],
  };
  const html = renderPage({
    page: 'setup',
    messages: [],
    approvals: [],
    state: { directories: [], events: [], setup: { health } },
  });
  assert(html.includes('qemu-system-x86'));
  assert(html.includes('usermod -aG kvm &quot;$USER&quot;'));
  assert(html.includes('下载 Lima 与 Codex'));
  assert(!html.includes('Homebrew'));
  assert(html.includes('QEMU：待完成'));
  assert(html.includes('KVM：待完成'));
  const ready = renderPage({
    page: 'setup',
    messages: [],
    approvals: [],
    state: {
      directories: [],
      events: [],
      setup: { health: { ...health, qemu: true, kvm: true, manualSteps: [] } },
    },
  });
  assert(!ready.includes('<pre>'));
  const mac = renderPage({
    page: 'setup',
    messages: [],
    approvals: [],
    state: {
      directories: [],
      events: [],
      setup: {
        health: { ...health, platform: 'darwin-arm64', qemu: null, kvm: null, manualSteps: [] },
      },
    },
  });
  assert(mac.includes('Homebrew'));
  assert(!mac.includes('KVM'));
  const unsupported = renderPage({
    page: 'setup',
    messages: [],
    approvals: [],
    state: { directories: [], events: [], setup: { health: { supported: false } } },
  });
  assert(unsupported.includes('x86_64 Linux'));
});

test('write approvals are marked and show the target and full text; connector cards render per auth kind', async () => {
  const { approvalSummary, renderPage } = await import('../src/renderer/views.mjs');
  const rows = Object.fromEntries(
    approvalSummary({
      operation: 'drive.update',
      account: 'g',
      params: {
        file_id: 'f1',
        name: 'Plan',
        expected_revision: 'r1',
        mime_type: 'text/plain',
        text: 'new body',
      },
    }),
  );
  assert.equal(rows['类型'], '写入');
  assert.equal(rows['目标'], 'Plan (f1) 修订 r1');
  assert.equal(rows['正文'], 'new body');
  const slack = Object.fromEntries(
    approvalSummary({
      operation: 'slack.post',
      account: 'g',
      params: { channel: 'C1', text: 'hi', thread_ts: '1.2' },
    }),
  );
  assert.equal(slack['目标'], '频道 C1 线程 1.2');
  assert.equal(
    Object.fromEntries(
      approvalSummary({ operation: 'gmail.list', account: 'g', params: { query: 'q', limit: 1 } }),
    )['类型'],
    undefined,
  );
  const { CONNECTORS } = require('../src/shared/connectors.cjs');
  const html = renderPage({
    page: 'permissions',
    messages: [],
    approvals: [],
    state: {
      directories: [],
      events: [],
      connectorCatalog: CONNECTORS,
      connectors: {
        gmail: { connected: true, auth: 'google' },
        drive: { connected: false, auth: 'google' },
        notion: { connected: true, auth: 'token', account: 'Acme' },
        slack: { connected: false, auth: 'token' },
        vault_unlocked: true,
      },
    },
  });
  assert(html.includes('data-connector="drive"'));
  assert(html.includes('Acme'));
  assert(html.includes('输入 Slack Bot 令牌'));
  assert(!html.includes('xoxb-1111'));
  assert((html.match(/data-connector-card=/g) || []).length === 4);
  const detail = renderPage({
    page: 'approvals',
    messages: [],
    approvals: [],
    approvalsLoaded: true,
    state: { directories: [], events: [] },
    detail: {
      id: 'x',
      state: 'PENDING',
      digest: 'd',
      expires: 1,
      action: {
        operation: 'notion.append',
        account: 'g',
        params: { page_id: 'p', paragraphs: ['a'], expected_last_edited: 'e', title: 'T' },
      },
    },
  });
  assert(detail.includes('write-banner'));
});
