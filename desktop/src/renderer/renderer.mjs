'use strict';
import { esc, button, renderPage } from './views.mjs';
const $ = (s) => document.querySelector(s);
let state = { directories: [], events: [], connected: false, busy: false },
  page = 'setup',
  env = '尚未检查',
  messages = [],
  approvals = [],
  approvalsLoaded = false,
  audit = null,
  detail = null,
  draft = '',
  locked = false,
  refreshTimer = null;
async function call(op, args) {
  return window.desktop.invoke(op, args);
}
const errors = {
  CODEX_TOKEN_EXPIRED_RELOGIN_ON_HOST:
    '模型认证已过期。进入首次设置点击「使用已有 Codex 登录」或「登录 / 重新认证」，不需要断开 Pi。',
  CODEX_TOKEN_EXPIRED_REIMPORT_ON_HOST:
    '模型认证已过期。进入首次设置点击「使用已有 Codex 登录」重新导入，不需要断开 Pi。',
  CODEX_AUTH_REQUIRED: '模型服务拒绝了当前认证。请在首次设置重新登录后再试。',
  CODEX_CONTEXT_TOO_LARGE: '会话上下文已达网关上限。请点击「新会话」继续，或拆分任务。',
  CODEX_USAGE_LIMIT: '订阅用量已达上限，请稍后再试。',
  DAILY_REQUEST_LIMIT: '已达到本 VM 每日模型请求上限，明天再试或调整任务。',
  PI_TURN_LIMIT: '本轮工具循环已达上限。请把任务拆小后再发送。',
  APPROVAL_WAIT_TIMEOUT: '等待审批超时，任务已停止。需要时重新发送，会生成新的审批。',
  GMAIL_REAUTH_REQUIRED: 'Gmail 授权已失效。请在「连接与权限」重新点击「连接 Google」。',
  VAULT_LOCKED: '凭证库已锁定，请进入首次设置解锁后重试。',
  SETUP_IN_PROGRESS: '设置正在进行，请等待完成。',
  DISCONNECT_PI_FIRST: '请先点击左下角「停止并断开 Pi」，再重建运行环境。',
  INSTALL_DEPENDENCIES_FIRST: '请先在步骤 1 安装系统依赖。',
  INSTALL_PI_FIRST: '请先完成步骤 2 的 Pi 安装；环境停止时先启动。',
  UNLOCK_VAULT_FIRST: '请先初始化或解锁凭证库。',
  DISK_SPACE_REQUIRED: '安装至少需要 8 GB 可用磁盘空间，请腾出空间后重试。',
  PI_NOT_READY: '请先连接 Pi，并等待当前任务结束。',
  PI_NOT_CONNECTED: 'Pi 尚未连接。请完成首次设置后连接。',
  HOMEBREW_REQUIRED: '请先从步骤 1 的链接安装 Homebrew，再重新检查。',
  PYTHON_NOT_INSTALLED: '未找到宿主 Python。请在首次设置步骤 1 安装依赖。',
  LIMA_NOT_INSTALLED: '尚未安装 Lima。请在首次设置步骤 1 点击「下载 Lima 与 Codex」。',
  TRUSTED_HELPER_FAILED: '无法连接可信服务。请检查 VM 是否运行，必要时在首次设置中修复 Pi。',
  DIRECTORY_CHANGED: '目录已被移动或替换，请在「连接与权限」重新确认后再访问。',
  TARGET_CHANGED: '目标在审批期间被修改，写入已取消。请重新读取后再试。',
  RUNTIME_DIRECTORY_NOT_ALLOWED:
    '该目录包含应用运行代码或工具安装文件，不能授予写权限。请选择独立的工作目录。',
  SAFE_UPDATE_UNAVAILABLE: '无法安全覆盖此文件：需要非空修订号；Google 文档目前仅支持读取和新建。',
  WRITE_EXECUTION_UNKNOWN: '远端写入结果不明，请先到对应账户核对，避免重复提交。',
  REQUEST_ALREADY_UNKNOWN: '该请求的远端结果仍不确定，已阻止重复执行。请到对应账户核对。',
  TARGET_NOT_WRITABLE: 'Drive 只允许更新由本应用创建的文件。',
  NOT_IN_CHANNEL: 'Bot 尚未加入该频道，请先在 Slack 中邀请它。',
  REAUTH_REQUIRED: '上游授权已失效，请在「连接与权限」重新连接。',
  DAILY_WRITE_LIMIT: '该连接器今日写入次数已达上限。',
  BAD_TOKEN_FORMAT: '令牌格式不正确，请检查前缀与长度。',
  PROVIDER_RATE_LIMITED: '上游服务限流，请稍后再试。',
  TOKEN_NOT_APPLICABLE: '该连接器使用 Google 授权，不接受粘贴令牌。',
  OAUTH_NOT_APPLICABLE: '该连接器使用令牌导入，不走 Google 授权。',
  PLATFORM_UNSUPPORTED: '此版本支持 Apple Silicon Mac 和 x86_64 Linux。',
  DOWNLOAD_CHECKSUM_MISMATCH: '下载内容校验失败，未安装任何文件。请检查网络后重试。',
  DOWNLOAD_HOST_NOT_ALLOWED: '下载被重定向到未知主机，已拒绝，未安装任何文件。',
  DOWNLOAD_TOO_LARGE: '下载内容超过大小上限，已中止，未安装任何文件。',
  DOWNLOAD_TOO_MANY_REDIRECTS: '下载重定向次数过多，已中止，未安装任何文件。',
  DOWNLOAD_FAILED: '下载失败，未安装任何文件。请检查网络后重试。',
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
  state = {
    ...(await call('snapshot')),
    gmail: state.gmail,
    connectors: state.connectors,
    rules: state.rules,
  };
  render();
}
/** Bursts of agent events collapse into one snapshot round trip. */
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh().catch((e) => notice(e.message));
  }, 50);
}
function modal(title, body) {
  $('#modal').innerHTML =
    `<h2 id="dialog-title">${title}</h2>${body}<div class="dialogfoot">${button('关闭', 'close')}</div>`;
  $('#modal').showModal();
}
function render() {
  const previousChat = $('.chatlog');
  const chatScroll = previousChat?.scrollTop || 0;
  const followChat =
    !previousChat || previousChat.scrollHeight - chatScroll - previousChat.clientHeight < 40;
  $('main').classList.toggle('agent-main', page === 'agent');
  // Re-rendering replaces the DOM; keep the caret where the user was typing.
  const active = document.activeElement;
  const focusId = active?.id || null;
  const selection =
    focusId && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd]
      : null;
  $('#version').textContent = '桌面开发版' + (state.version ? ' · ' + state.version : '');
  $('#status').textContent = state.connected
    ? state.busy
      ? '● Pi 任务执行中'
      : '● Pi 已连接'
    : state.starting
      ? '◌ 正在连接 Pi'
      : '○ Pi 未连接';
  $('#status').title = $('#status').textContent;
  $('#status').setAttribute('aria-label', $('#status').textContent);
  $('#approvals-badge').textContent = approvals.length ? String(approvals.length) : '';
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
    audit,
  });
  const chat = $('.chatlog');
  if (chat) chat.scrollTop = followChat ? chat.scrollHeight : chatScroll;
  if (focusId) {
    const element = document.getElementById(focusId);
    if (element && !element.disabled) {
      element.focus({ preventScroll: true });
      if (selection && typeof element.setSelectionRange === 'function')
        element.setSelectionRange(selection[0], selection[1]);
    }
  }
}
async function loadApprovals({ show = true } = {}) {
  const value = await call('approvals');
  approvals = value.pending;
  approvalsLoaded = true;
  if (show) page = 'approvals';
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
    const status = await call('connector-status', { connector: 'gmail' });
    state.gmail = status;
    state.connectors = status;
    render();
  },
  'connectors-status': async () => {
    await acts['gmail-status']();
    state.rules = (await call('rules')).rules;
    render();
  },
  'model-auto': async () => {
    const result = await call('model-mode', { mode: 'auto' });
    notice(result.cancelled ? '已取消。' : '模型调用已恢复持续授权。');
    await acts['connectors-status']();
  },
  'model-ask': async () => {
    await call('model-mode', { mode: 'ask' });
    notice('模型调用改为逐轮审批；待消费的授权已作废。');
    await acts['connectors-status']();
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
  audit: async () => {
    audit = (await call('audit')).audit;
    render();
  },
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
function navigate(next) {
  page = next;
  render();
  if (next === 'approvals') void perform(() => loadApprovals());
  if (next === 'permissions' && !state.gmail) void perform(acts['gmail-status']);
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'prompt') draft = e.target.value;
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'sidebar-toggle') {
    const collapsed = $('.shell').classList.toggle('sidebar-collapsed');
    const label = collapsed ? '展开导航' : '收起导航';
    b.setAttribute('aria-expanded', String(!collapsed));
    b.setAttribute('aria-label', label);
    b.title = label;
    b.querySelector('span').textContent = collapsed ? '»' : '«';
    return;
  }
  // Navigation never waits behind a long-running action such as starting the VM.
  if (b.dataset.page) {
    navigate(b.dataset.page);
    return;
  }
  void perform(async () => {
    if (b.dataset.act) {
      await acts[b.dataset.act]?.();
      return;
    }
    if (b.dataset.connector && b.dataset.cact) {
      const connector = b.dataset.connector;
      const action = b.dataset.cact;
      if (action === 'import-client') await call('gmail-import');
      else if (action === 'mode-auto') {
        const result = await call('connector-mode', { connector, mode: 'auto' });
        notice(result.cancelled ? '已取消，现有设置未改变。' : '已恢复持续授权。');
      } else if (action === 'mode-ask') {
        await call('connector-mode', { connector, mode: 'ask' });
        notice('已改为逐次审批；待消费的授权已作废。');
      } else {
        const result = await call('connector-' + action, { connector });
        if (result?.cancelled) notice('已取消。');
        else if (result?.manual_step)
          notice('本机凭证已删除。Notion 没有远端撤销接口，请到 Notion 设置中移除该集成。');
      }
      await acts['connectors-status']();
      await refresh();
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
  if (event.type === 'gmail_changed' || event.type === 'connectors_changed')
    void acts['connectors-status']().catch((e) => notice(e.message));
  if (event.type === 'ready') messages = [];
  if (messages.length > 200) messages = messages.slice(-200);
  if (event.type === 'assistant' && event.text)
    messages.push({ role: 'assistant', text: event.text });
  if (event.type === 'user') messages.push({ role: 'user', text: event.text });
  if (event.type === 'approval_required') {
    notice('Pi 提示需要审批。请进入独立审批页，从策略服务读取详情。');
    void loadApprovals({ show: false }).catch(() => {});
  }
  if (event.type === 'turn_error' || event.type === 'protocol_error')
    notice('Pi 错误：' + event.error);
  if (event.type === 'assistant' && event.error) notice('模型调用失败：' + event.error);
  scheduleRefresh();
});
void refresh()
  .then(() => acts['setup-status']())
  // The policy service lives in the VM; before it runs there are no rules to read, not an error.
  .then(() => (state.setup?.health?.vm === 'Running' ? call('rules') : null))
  .then((value) => {
    if (!value) return;
    state.rules = value.rules;
    render();
  })
  .catch((e) => notice(e.message));
