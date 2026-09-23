const { test, beforeEach } = require('node:test');
beforeEach(async () => {
  (await import('../src/renderer/i18n.mjs')).setLocale('zh-CN');
});
const assert = require('node:assert/strict');

test('activity distinguishes failure, cancellation and unknown outcomes', async () => {
  const { describeActivity } = await import('../src/renderer/activity.mjs');
  assert.equal(describeActivity({ type: 'finished', success: false }).tone, 'error');
  assert.equal(describeActivity({ type: 'finished', cancelled: true }).title, '任务已取消');
  assert.equal(describeActivity({ type: 'finished' }).title, '任务已结束');
  assert.equal(describeActivity({ type: 'tool_end', tool: 'bash', is_error: true }).tone, 'error');
  assert.equal(describeActivity({ type: 'tool_end', tool: 'bash' }).title, 'Shell 命令 · 执行结束');
  const result = describeActivity({ type: 'activity', text: '审批 abc123：approve' });
  assert.equal(result.title, '审批请求已批准');
  assert.equal(result.approvalId, 'abc123');
});

test('timeline groups dates, keeps missing times honest and escapes metadata', async () => {
  const { renderActivity } = await import('../src/renderer/activity.mjs');
  const html = renderActivity([
    { type: 'user', text: 'PRIVATE_CHAT' },
    { type: 'ready', time: '2026-09-21T20:00:00Z' },
    { type: 'tool_start', tool: 'notion_search', time: '2026-09-21T20:00:01Z' },
    { type: 'tool_end', tool: 'notion_search', time: '2026-09-21T20:00:02Z' },
    { type: 'approval_required', approval_id: '<img src=x>', time: 'invalid' },
    { type: 'finished', success: true },
  ]);
  assert(html.includes('最近 5 条活动'));
  assert.equal((html.match(/<h2>时间未知<\/h2>/g) || []).length, 1);
  assert(html.includes('2026年9月21日'));
  assert(html.indexOf('Notion 搜索 · 执行结束') < html.indexOf('开始：Notion 搜索'));
  assert(html.includes('&lt;img src=x&gt;'));
  assert(!html.includes('<img'));
  assert(!html.includes('PRIVATE_CHAT'));
  assert(!html.includes('Invalid Date'));
});

test('activity module is available through the desktop asset protocol', async () => {
  const { serveAsset } = require('../src/main/security.cjs');
  const path = require('node:path');
  const response = await serveAsset(
    { url: 'anchi://app/activity.mjs', method: 'GET' },
    path.join(__dirname, '../src/renderer'),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /javascript/);
});
