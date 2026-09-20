'use strict';
import { esc, button, renderPage } from './views.mjs';
const $ = (s) => document.querySelector(s);
let state = { directories: [], events: [], connected: false, busy: false },
  page = 'setup',
  env = '尚未检查',
  messages = [],
  approvals = [],
  approvalsLoaded = false,
  detail = null,
  draft = '',
  locked = false;
async function call(op, args) {
  return window.desktop.invoke(op, args);
}
const errors = {
  CODEX_TOKEN_EXPIRED_RELOGIN_ON_HOST: '模型认证已过期。请断开 Pi，进入首次设置重新登录。',
  VAULT_LOCKED: '凭证库已锁定，请进入首次设置解锁后重试。',
  SETUP_IN_PROGRESS: '设置正在进行，请等待完成。',
  DISCONNECT_PI_FIRST: '请先点击左下角「停止并断开 Pi」，再修改运行环境。',
  INSTALL_DEPENDENCIES_FIRST: '请先在步骤 1 安装系统依赖。',
  INSTALL_PI_FIRST: '请先完成步骤 2 的 Pi 安装；环境停止时先启动。',
  UNLOCK_VAULT_FIRST: '请先初始化或解锁凭证库。',
  DISK_SPACE_REQUIRED: '安装至少需要 8 GB 可用磁盘空间，请腾出空间后重试。',
  PI_NOT_READY: '请先连接 Pi，并等待当前任务结束。',
  PI_NOT_CONNECTED: 'Pi 尚未连接。请完成首次设置后连接。',
  HOMEBREW_REQUIRED: '请先从步骤 1 的链接安装 Homebrew，再重新检查。',
  TRUSTED_HELPER_FAILED: '无法连接可信服务。请检查 VM 是否运行，必要时在首次设置中修复 Pi。',
};
function notice(text) {
  for (const [code, message] of Object.entries(errors))
    if (String(text).includes(code)) {
      text = message;
      break;
    }
  $('#notice').textContent = text;
}
async function refresh() {
  state = { ...(await call('snapshot')), gmail: state.gmail };
  render();
}
function modal(title, body) {
  $('#modal').innerHTML =
    `<h2 id="dialog-title">${title}</h2>${body}<div class="dialogfoot">${button('关闭', 'close')}</div>`;
  $('#modal').showModal();
}
function render() {
  $('#status').textContent = state.connected
    ? state.busy
      ? '● Pi 任务执行中'
      : '● Pi 已连接'
    : state.starting
      ? '◌ 正在连接 Pi'
      : '○ Pi 未连接';
  $('#crumb').textContent = {
    setup: '首次设置',
    agent: 'Agent',
    permissions: '连接与权限',
    approvals: '独立审批',
    activity: '活动记录',
  }[page];
  document
    .querySelectorAll('[data-page]')
    .forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $('#app').innerHTML = renderPage({
    page,
    state,
    env,
    messages,
    draft,
    approvals,
    detail,
    approvalsLoaded,
  });
}
async function loadApprovals() {
  const value = await call('approvals');
  approvals = value.pending;
  approvalsLoaded = true;
  page = 'approvals';
  render();
}
const acts = {
  'setup-status': async () => {
    state.setup = await call('setup-status');
    render();
  },
  'setup-homebrew': async () => {
    await call('setup-dependency-installer');
  },
  'setup-cancel-login': async () => {
    await call('setup-cancel-login');
    await refresh();
  },
  'go-agent': () => {
    page = 'agent';
    render();
  },
  'first-task': async () => {
    messages = [];
    await call('first-task');
    page = 'agent';
    await refresh();
  },
  ...Object.fromEntries(
    ['dependencies', 'install', 'unlock', 'login', 'import'].map((action) => [
      'setup-' + action,
      async () => {
        await call('setup-start', { action });
        await refresh();
      },
    ]),
  ),
  close: () => $('#modal').close(),
  environment: async () => {
    const value = await call('environment');
    env =
      value.instances.map((x) => `${x.name} · ${x.status} · ${x.arch}`).join(', ') ||
      '未找到 secure-vm';
    render();
  },
  'vm-start': async () => {
    notice('正在启动已有 VM…');
    await call('vm-start');
    await acts.environment();
    notice('VM 已启动。重启后可能需要先解锁凭证库。');
  },
  connect: async () => {
    await call('connect');
    await refresh();
  },
  disconnect: async () => {
    await call('disconnect');
    await refresh();
  },
  status: async () => {
    await call('rpc', { op: 'status' });
    await refresh();
  },
  cancel: async () => {
    await call('rpc', { op: 'cancel' });
    await refresh();
    notice('本地任务已取消。待审批请求请在独立审批页拒绝或撤销。');
  },
  new: async () => {
    await call('rpc', { op: 'new' });
    messages = [];
    await refresh();
  },
  history: async () => {
    const value = await call('rpc', { op: 'history' });
    messages = value.messages;
    render();
  },
  sessions: async () => {
    const value = await call('rpc', { op: 'sessions' });
    modal(
      '恢复 Pi 会话',
      `<p class="muted">恢复上下文不恢复授权，也不自动执行任务。</p>${value.sessions.map((s) => `<div class="resource"><span class="caption">${esc(s.modified)}</span><br><button data-resume="${esc(s.session_id)}">${esc(s.session_id)}</button></div>`).join('') || '没有已保存会话。'}`,
    );
  },
  'add-ro': async () => {
    await call('directories-add', { mode: 'ro' });
    await refresh();
  },
  'add-rw': async () => {
    await call('directories-add', { mode: 'rw' });
    await refresh();
  },
  'gmail-status': async () => {
    state.gmail = await call('gmail-status');
    render();
  },
  'gmail-import': async () => {
    await call('gmail-import');
    await acts['gmail-status']();
  },
  'gmail-connect': async () => {
    await call('gmail-connect');
    await refresh();
  },
  'gmail-cancel': async () => {
    await call('gmail-cancel');
    await refresh();
  },
  'gmail-disconnect': async () => {
    await call('gmail-disconnect');
    await acts['gmail-status']();
    await refresh();
  },
  'gmail-allow': async () => {
    const result = await call('gmail-read', { mode: 'allow' });
    notice(result.cancelled ? '已取消授权，现有权限未改变。' : '已允许持续只读访问。');
  },
  'gmail-deny': async () => {
    await call('gmail-read', { mode: 'deny' });
    notice('持续读取已撤销；待处理审批已撤销。');
  },
  approvals: loadApprovals,
  approve: async () => decide('approve'),
  deny: async () => decide('deny'),
  revoke: async () => decide('revoke'),
};
async function decide(decision) {
  if (!detail) return;
  await call('approval-decide', { id: detail.id, digest: detail.digest, decision });
  detail = await call('approval-show', { id: detail.id });
  await loadApprovals();
}
async function perform(fn) {
  if (locked) return;
  locked = true;
  notice('');
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  } finally {
    locked = false;
  }
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'prompt') draft = e.target.value;
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  void perform(async () => {
    if (b.dataset.page) {
      page = b.dataset.page;
      render();
      return;
    }
    if (b.dataset.act) {
      await acts[b.dataset.act]?.();
      return;
    }
    if (b.dataset.activate) {
      await call('directories-activate', { id: b.dataset.activate });
      await refresh();
      return;
    }
    if (b.dataset.mode) {
      await call('directories-mode', { id: b.dataset.mode, mode: b.dataset.value });
      await refresh();
      return;
    }
    if (b.dataset.remove) {
      await call('directories-remove', { id: b.dataset.remove });
      await refresh();
      return;
    }
    if (b.dataset.inspect) {
      detail = await call('approval-show', { id: b.dataset.inspect });
      render();
      return;
    }
    if (b.dataset.resume) {
      await call('rpc', { op: 'resume', args: { session_id: b.dataset.resume } });
      $('#modal').close();
      await acts.history();
      await refresh();
    }
  });
});
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'compose') return;
  e.preventDefault();
  void perform(async () => {
    const text = draft.trim();
    if (!text) return;
    await call('rpc', { op: 'prompt', args: { text } });
    draft = '';
    await refresh();
  });
});
window.desktop.onEvent((event) => {
  if (event.type === 'setup_changed') notice(event.job.message);
  if (event.type === 'finished' && event.success)
    notice('任务已完成。可继续对话，或返回首次设置查看下一步。');
  if (event.type === 'gmail_changed') void acts['gmail-status']().catch((e) => notice(e.message));
  if (event.type === 'ready') messages = [];
  if (messages.length > 200) messages = messages.slice(-200);
  if (event.type === 'assistant' && event.text)
    messages.push({ role: 'assistant', text: event.text });
  if (event.type === 'user') messages.push({ role: 'user', text: event.text });
  if (event.type === 'approval_required')
    notice('Pi 提示需要审批。请进入独立审批页，从策略服务读取详情。');
  if (event.type === 'turn_error' || event.type === 'protocol_error')
    notice('Pi 错误：' + event.error);
  if (event.type === 'assistant' && event.error) notice('模型调用失败：' + event.error);
  void refresh().catch((e) => notice(e.message));
});
void refresh()
  .then(() => acts['setup-status']())
  .catch((e) => notice(e.message));
