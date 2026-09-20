export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const button = (text, act, cls = '') =>
  `<button class="${cls}" data-act="${act}">${text}</button>`;

export function renderPage({
  page,
  state,
  env,
  messages,
  draft,
  approvals,
  detail,
  approvalsLoaded,
}) {
  if (page === 'setup') {
    const h = state.setup?.health;
    const job = state.setup?.job;
    const label = (value) => (value ? '已就绪' : '待完成');
    const stepButton = (text, action, enabled = true) =>
      button(text, action).replace(
        '<button ',
        '<button ' + (enabled && job?.state !== 'running' ? '' : 'disabled '),
      );
    return `<div class="eyebrow">WELCOME / PI</div><h1>从这里开始使用 Pi</h1>
      <p class="muted">完成环境、模型登录和一次示例任务。Gmail 和本地目录可以稍后连接。</p>
      <div class="actions">${button('重新检查', 'setup-status')}${button('进入对话', 'go-agent')}</div>
      ${job ? `<div class="note" role="status">${esc({ dependencies: '安装系统依赖', install: '安装 Pi 环境', unlock: '解锁凭证库', login: '浏览器登录', import: '导入已有登录' }[job.action])} · ${esc(job.state)}<p>${esc(job.message)}</p>${job.state === 'running' && job.action === 'login' && job.phase === 'browser' ? button('取消登录', 'setup-cancel-login') : ''}</div>` : ''}
      ${
        !h
          ? '<div class="card">正在检查本机环境…</div>'
          : !h.supported
            ? '<div class="card">此版本支持 Apple Silicon Mac。请在支持的设备上运行。</div>'
            : `
      <div class="card"><h2>1 · 准备系统环境</h2><p>Lima：${label(h.lima)} · Python：${label(h.python)} · Codex：${label(h.codex)}</p>
      <p class="muted">当前可用磁盘 ${esc(h.freeGiB)} GB；安装至少需要 8 GB。首次安装可能需要数分钟。</p>
      ${!h.brew ? `<p>先下载 Homebrew 的 .pkg 安装包，在系统安装器完成安装，再回到这里重新检查。</p>${button('打开 Homebrew 安装包下载页', 'setup-homebrew')}` : stepButton('安装或补齐依赖', 'setup-dependencies')}
      </div>
      <div class="card"><h2>2 · 安装 Pi 安全环境</h2><p>环境：${esc(h.vm)} · Pi：${label(h.installed)}</p>
      <p class="muted">独立 Linux 环境使用 4 GB 内存、最多 30 GB 虚拟磁盘；保留已有账户和工作区。</p>
      ${stepButton(h.installed ? '修复 / 更新 Pi' : '安装 Pi', 'setup-install', h.lima && h.python)}${h.vm === 'Stopped' ? button('启动环境', 'vm-start') : ''}
      </div>
      <div class="card"><h2>3 · 连接模型</h2><p>凭证库：${h.unlocked ? '已解锁' : '未解锁'} · 模型认证：${label(h.configured)}${h.model ? ' · ' + esc(h.model) : ''}</p>
      <div class="actions">${stepButton('初始化 / 解锁', 'setup-unlock', h.installed)}${stepButton('使用已有 Codex 登录', 'setup-import', h.unlocked)}${stepButton('登录 / 重新认证', 'setup-login', h.unlocked && h.codex)}</div>
      <p class="muted">登录会打开系统浏览器。使用你的 ChatGPT 订阅，短期访问令牌保存在隔离认证层。到期后从这里重新认证。请备份本机主密钥；详情见使用说明。</p>
      </div>
      <div class="card"><h2>4 · 完成第一个任务</h2><p>示例：把一段虚构项目计划整理为三条待办。不需要连接邮箱或授权目录。</p>
      ${state.firstTask?.state === 'succeeded' || state.setup?.completedAt ? '<div class="note">首个任务已返回结果。你可以继续对话，或到「连接与权限」添加自己的资源。</div>' : state.firstTask?.state === 'failed' ? '<p class="error">任务未完成。检查模型认证和审批状态后重试。</p>' : ''}
      <div class="actions">${stepButton(state.connected ? 'Pi 已连接' : '连接 Pi', 'connect', h.configured && !state.connected)}${stepButton('开始示例任务', 'first-task', state.connected && !state.busy)}${button('查看待审批请求', 'approvals')}${button('查看结果', 'go-agent')}</div>
      <p class="muted">先连接 Pi，再开始任务。模型请求会等待你在「独立审批」中查看完整内容并确认。未批准不会调用模型。</p>
      </div>`
      }`;
  }
  if (page === 'agent') {
    return /* HTML */ `<div class="row">
        <div>
          <div class="eyebrow">PI / LOCAL WORKSPACE</div>
          <h1>你的本地工作助理</h1>
          <span class="muted">首次使用请完成「首次设置」，之后可继续会话或开始新任务。</span>
        </div>
        <span class="tag">${state.connected ? '已连接真实 agent' : '等待连接'}</span>
      </div>
      <div class="card">
        <div class="row">
          <div>
            <h3>secure-vm</h3>
            <span class="caption">${esc(env)}</span>
          </div>
          <div class="actions">
            ${button('检查环境', 'environment')}${button('启动已有 VM', 'vm-start')}${button(state.connected ? '刷新状态' : '连接 Pi', state.connected ? 'status' : 'connect', 'primary')}
          </div>
        </div>
        <p class="caption path">
          模型认证由隔离认证层托管。认证过期或环境未就绪时，请前往「首次设置」。
        </p>
      </div>
      <div class="actions toolbar">
        ${button('新会话', 'new')}${button('恢复会话', 'sessions')}${button('加载历史', 'history')}${button('停止任务', 'cancel')}
      </div>
      <p class="caption">会话：${esc(state.sessionId || '未连接')} · 新会话不继承旧审批</p>
      <div class="chatlog">
        ${messages.length ? messages.map((m) => `<div class="bubble ${m.role === 'user' ? 'user' : ''}"><span class="caption">${m.role === 'user' ? '你' : 'Pi'}</span><br>${esc(m.text)}</div>`).join('') : '<div class="card"><h2>先连接，再开始对话。</h2><p class="muted">可以先发送「介绍一下你自己，不要使用工具」。模型调用会进入独立审批。</p></div>'}
      </div>
      ${state.busy ? `<div class="note">任务执行中。如收到审批提示，请进入「独立审批」核对真实请求。${button('查看审批', 'approvals')}</div>` : ''}
      <form id="compose" class="composer">
        <textarea
          id="prompt"
          aria-label="发送给 Pi 的需求"
          maxlength="8000"
          placeholder="描述你希望完成的任务…"
          ${!state.connected || state.busy ? 'disabled' : ''}
        >
${esc(draft)}</textarea
        ><button class="primary" ${!state.connected || state.busy ? 'disabled' : ''}>发送</button>
      </form>
      <p class="caption">
        本地目录通过 host_files 工具访问；shell 仅能访问 cell 工作区。Gmail
        为只读，模型调用仍需独立审批。
      </p>`;
  } else if (page === 'permissions') {
    return /* HTML */ `<div class="eyebrow">PERMISSIONS</div>
      <h1>明确每一项访问范围</h1>
      <p class="muted">本次应用运行期间授权有效；重启后需要重新启用。</p>
      <div class="card">
        <div class="row">
          <h2>本地目录</h2>
          <div class="actions">
            ${button('＋ 选择只读目录', 'add-ro')}${button('＋ 选择读写目录', 'add-rw')}
          </div>
        </div>
        <div class="note">
          目录由宿主文件代理逐次校验权限，不直接挂载到 VM。撤销会等待已开始的操作结束。
        </div>
        ${state.directories.map((d) => `<div class="resource row"><div><strong>${esc(d.path.split('/').pop())}</strong> <span class="tag">${d.status === 'active' ? '已授权' : '未启用'} · ${d.mode === 'ro' ? '只读' : '读写'}</span><div class="caption path">${esc(d.path)}</div></div><div class="actions">${d.status !== 'active' ? `<button data-activate="${esc(d.id)}">启用授权</button>` : ''}<button data-mode="${esc(d.id)}" data-value="${d.mode === 'ro' ? 'rw' : 'ro'}">改为${d.mode === 'ro' ? '读写' : '只读'}</button><button data-remove="${esc(d.id)}">撤销并移除</button></div></div>`).join('') || '<p class="muted">尚未选择目录。建议原始资料只读、结果目录读写。</p>'}
        <p class="caption">
          支持最多 24 KB 的 UTF-8 文本读写、创建子目录和删除普通文件。列表最多 100
          项。拒绝隐藏路径、符号链接、硬链接和常见凭证目录。
        </p>
      </div>
      <div class="card">
        <h2>Gmail · 只读连接</h2>
        <p>
          ${esc(state.gmail ? (state.gmail.connected ? '账户已连接' : '账户未连接') + (state.gmail.vault_unlocked ? ' · 凭证库已解锁' : ' · 凭证库已锁定') : '尚未检查账户状态')}
        </p>
        <p class="caption">
          ${state.gmail?.revocation_pending ? 'Google 远端撤销待重试，请再次点击断开账户。' : ''}${state.oauth?.pending ? '正在等待浏览器授权…' : ''}
        </p>
        <div class="actions">
          ${button('刷新账户状态', 'gmail-status')}${button('导入客户端 JSON', 'gmail-import')}${button('连接 Google', 'gmail-connect')}${button('取消授权流程', 'gmail-cancel')}
        </div>
        <div class="actions">
          ${button('允许 Agent 持续只读', 'gmail-allow')}${button('撤销持续读取许可', 'gmail-deny')}${button('断开账户', 'gmail-disconnect')}
        </div>
        <p class="muted">
          OAuth 凭证只由 VM 认证层保存。连接账户与允许 Agent
          读取是两个独立动作。撤销持续许可后，新请求需逐次审批；断开账户将停止
          Pi、撤销待处理审批并撤销 Google 令牌，在途远端操作无法回滚。
        </p>
      </div>`;
  } else if (page === 'approvals') {
    return /* HTML */ `<div class="row">
        <div>
          <div class="eyebrow">TRUSTED CONTROL PLANE</div>
          <h1>独立审批</h1>
        </div>
        ${button('从策略服务刷新', 'approvals')}
      </div>
      <p class="muted">请求详情直接读取可信策略服务；agent 的消息只能提示有请求，不能批准自己。</p>
      <div class="card">
        ${approvals.length ? approvals.map((a) => `<div class="resource row"><div><strong>${esc(a.principal)}</strong><div class="caption">${esc(a.id)} · 到期 ${esc(new Date(a.expires * 1000).toLocaleTimeString())}</div></div><button data-inspect="${esc(a.id)}">查看完整请求</button></div>`).join('') : approvalsLoaded ? '已刷新，当前没有待审批请求。' : '尚未载入。点击刷新获取最新状态。'}
      </div>
      ${detail ? `<div class="card"><h2>请求 ${esc(detail.id)}</h2><span class="tag">${esc(detail.state)}</span><p class="caption path">SHA-256：${esc(detail.digest)}</p><p class="muted">下方为完整动作内容，可能包含将发送到模型的文件或邮件正文。请核对后决定。</p><pre>${esc(JSON.stringify(detail.action, null, 2))}</pre><div class="actions">${detail.state === 'PENDING' ? button('批准这份请求', 'approve', 'primary') + button('拒绝', 'deny') : ''}${button('撤销', 'revoke')}</div></div>` : ''}`;
  } else {
    return /* HTML */ `<div class="eyebrow">ACTIVITY</div>
      <h1>本次应用运行记录</h1>
      <p class="muted">事件仅保留最近 200 条于内存；完整策略审计仍在 VM。这里不复制聊天正文。</p>
      <div class="card">
        ${
          state.events
            .filter((e) => !['assistant', 'user', 'response'].includes(e.type))
            .slice()
            .reverse()
            .map(
              (e) =>
                `<div class="resource"><span class="tag">${esc(e.type)}</span> ${esc(e.text || e.error || e.tool || e.approval_id || '')} ${e.type === 'finished' ? esc(e.success ? '任务成功' : e.cancelled ? '任务取消' : '任务失败') : ''}</div>`,
            )
            .join('') || '尚无活动。'
        }
      </div>`;
  }
}
