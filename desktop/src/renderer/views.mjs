export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const button = (text, act, cls = '') =>
  `<button class="${cls}" data-act="${act}">${text}</button>`;
const clock = (seconds) =>
  Number.isFinite(seconds) ? new Date(seconds * 1000).toLocaleString() : '未知';

/** Structured, escaped summary of a trusted policy action; the raw JSON stays available below it. */
export function approvalSummary(action) {
  if (!action || typeof action !== 'object') return [];
  const params = action.params && typeof action.params === 'object' ? action.params : {};
  const rows = [
    ['操作', action.operation],
    ['账户 generation', action.account],
  ];
  if (typeof params.model === 'string') rows.push(['模型', params.model]);
  if (Array.isArray(params.input)) {
    rows.push(['上下文条目', `${params.input.length} 条`]);
    const last = [...params.input]
      .reverse()
      .find(
        (item) =>
          item && (item.type === 'message' || item.type === undefined) && item.role === 'user',
      );
    const text = Array.isArray(last?.content)
      ? last.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
      : typeof last?.content === 'string'
        ? last.content
        : '';
    if (text) rows.push(['最近用户输入', text.length > 300 ? text.slice(0, 300) + '…' : text]);
  }
  if (Array.isArray(params.tools))
    rows.push([
      '模型可调用工具',
      params.tools.length ? params.tools.map((t) => t?.name ?? '?').join(', ') : '无',
    ]);
  if (typeof params.instructions === 'string')
    rows.push(['系统指令长度', `${params.instructions.length} 字符`]);
  if (typeof params.query === 'string') rows.push(['Gmail 查询', params.query]);
  if (params.limit !== undefined) rows.push(['数量上限', String(params.limit)]);
  if (typeof params.id === 'string') rows.push(['邮件 ID', params.id]);
  if (isWrite(action.operation)) {
    rows.unshift(['类型', '写入']);
    const target =
      params.expected_revision !== undefined
        ? `${params.name ?? ''} (${params.file_id}) 修订 ${params.expected_revision}`
        : params.expected_last_edited !== undefined
          ? `${params.title ?? ''} (${params.page_id}) 编辑于 ${params.expected_last_edited}`
          : params.parent_page_id
            ? `父页面 ${params.parent_page_id} · 新页面《${params.title ?? ''}》`
            : params.parent_id
              ? `文件夹 ${params.parent_id} / ${params.name ?? ''}`
              : params.channel
                ? `频道 ${params.channel}${params.thread_ts ? ' 线程 ' + params.thread_ts : ''}`
                : '';
    if (target) rows.push(['目标', target]);
    const body =
      typeof params.text === 'string'
        ? params.text
        : Array.isArray(params.paragraphs)
          ? params.paragraphs.join('\n')
          : '';
    if (body) rows.push(['正文', body]);
  }
  return rows;
}
export const isWrite = (operation) =>
  /\.(create|update|create_page|append|post)$/.test(operation || '');

const connectorStatusText = (status) => {
  if (!status) return '尚未检查';
  if (status.reauth_required) return '需要重新认证：上游授权已失效，请重新连接';
  if (!status.connected) return '未连接';
  return '已连接' + (status.account ? ' · ' + status.account : '');
};

/** One card per connector; buttons carry data-connector + data-cact and are dispatched by the renderer. */
const modeText = (mode) =>
  mode === 'ask'
    ? '逐次审批：每个操作都进入独立审批'
    : '持续授权：读写与模型调用由策略自动放行（默认）';

export function connectorCard(descriptor, status, pending, mode = 'auto') {
  const act = (label, action, cls = '') =>
    `<button class="${cls}" data-connector="${esc(descriptor.id)}" data-cact="${action}">${label}</button>`;
  const authButtons =
    descriptor.auth === 'google'
      ? act('导入客户端 JSON', 'import-client') +
        act('连接 Google', 'connect') +
        act('取消授权流程', 'cancel')
      : act(
          `输入 ${descriptor.label} ${descriptor.id === 'slack' ? 'Bot ' : ''}令牌`,
          'import-token',
        );
  return `<div class="card" data-connector-card="${esc(descriptor.id)}">
      <h2>${esc(descriptor.label)}</h2>
      <p class="${status?.reauth_required ? 'error' : ''}">${esc(connectorStatusText(status))}</p>
      <p class="caption">${esc(descriptor.scopeText)}</p>
      <p class="caption">${status?.revocation_pending ? '远端撤销待重试，请再次点击断开。' : ''}${pending ? '正在等待浏览器授权…' : ''}</p>
      <div class="actions">${authButtons}${act('断开', 'disconnect')}</div>
      <p class="caption">${esc(modeText(mode))}</p>
      <div class="actions">${mode === 'ask' ? act('恢复持续授权', 'mode-auto') : act('改为逐次审批', 'mode-ask')}</div>
      ${descriptor.tokenHint ? `<p class="muted">${esc(descriptor.tokenHint)}</p>` : ''}
      <p class="muted">${esc(descriptor.dataText)} 连接即授权：连接后 Agent 可持续读写；改为逐次审批后每个操作都需你确认。</p>
    </div>`;
}

const directoryStatus = (d) => {
  if (d.status === 'active') return '已授权';
  if (d.reason === 'DIRECTORY_CHANGED') return '目录已变化，需重新确认';
  if (d.reason && d.reason !== 'CONSENT_REQUIRED') return '目录不可访问，需重新确认';
  return '未启用';
};

export function renderPage({
  page,
  state,
  env,
  messages,
  draft,
  approvals,
  detail,
  approvalsLoaded,
  audit,
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
    const expiresAt = Number(h?.expires_at);
    const remaining = Number.isFinite(expiresAt) ? expiresAt * 1000 - Date.now() : NaN;
    const expiry = !Number.isFinite(remaining)
      ? ''
      : remaining <= 0
        ? '<p class="error">模型认证已过期。点击「使用已有 Codex 登录」或「登录 / 重新认证」更新，不需要断开 Pi。</p>'
        : remaining < 30 * 60 * 1000
          ? `<p class="warn">模型认证将于 ${esc(clock(expiresAt))} 到期，建议现在重新导入。</p>`
          : `<p class="caption">模型认证有效至 ${esc(clock(expiresAt))}。</p>`;
    const versionNote =
      h?.runtime_version && state.version && h.runtime_version !== state.version
        ? `<p class="warn">VM 内服务版本 ${esc(h.runtime_version)} 与应用版本 ${esc(state.version)} 不同，建议点击「修复 / 更新 Pi」同步。</p>`
        : '';
    const linux = h?.platform === 'linux-x64';
    const disk = `当前可用磁盘 ${esc(h?.freeGiB)} GB；安装至少需要 8 GB。`;
    const stepOne = !h
      ? ''
      : linux
        ? `<div class="card"><h2>1 · 准备系统环境</h2><p>Lima：${label(h.lima)} · Codex：${label(h.codex)} · Python：${label(h.python)} · QEMU：${label(h.qemu)} · KVM：${label(h.kvm)}</p>
      <p class="muted">Lima 与 Codex 由应用按固定版本和 SHA-256 下载到 ~/.local/share/anchi/tools，不需要管理员密码。${disk}</p>
      ${h.manualSteps?.length ? `<p>${h.kvm === false ? 'QEMU 与 KVM 权限需要你在终端执行：' : '安装 QEMU 需要你在终端执行：'}</p><pre>${esc(h.manualSteps.join('\n'))}</pre><p class="caption">${h.kvm === false ? '加入 kvm 组后需退出登录并重新登录，再点「重新检查」。' : '执行后点「重新检查」。'}</p>` : ''}
      <div class="actions">${stepButton('下载 Lima 与 Codex', 'setup-dependencies')}${button('查看 Linux 安装说明', 'setup-homebrew')}</div>
      </div>`
        : `<div class="card"><h2>1 · 准备系统环境</h2><p>Lima：${label(h.lima)} · Python：${label(h.python)} · Codex：${label(h.codex)}</p>
      <p class="muted">${disk}首次安装可能需要数分钟。</p>
      ${!h.brew ? `<p>先下载 Homebrew 的 .pkg 安装包，在系统安装器完成安装，再回到这里重新检查。</p>${button('打开 Homebrew 安装包下载页', 'setup-homebrew')}` : stepButton('安装或补齐依赖', 'setup-dependencies')}
      </div>`;
    return `<div class="eyebrow">WELCOME / PI</div><h1>从这里开始使用 Pi</h1>
      <p class="muted">完成环境、模型登录和一次示例任务。Gmail 和本地目录可以稍后连接。</p>
      <div class="actions">${button('重新检查', 'setup-status')}${button('进入对话', 'go-agent')}</div>
      ${job ? `<div class="note" role="status">${esc({ dependencies: '安装系统依赖', install: '安装 Pi 环境', unlock: '解锁凭证库', login: '浏览器登录', import: '导入已有登录' }[job.action])} · ${esc(job.state)}<p>${esc(job.message)}</p>${job.state === 'running' && job.action === 'login' && job.phase === 'browser' ? button('取消登录', 'setup-cancel-login') : ''}</div>` : ''}
      ${
        !h
          ? '<div class="card">正在检查本机环境…</div>'
          : !h.supported
            ? '<div class="card">此版本支持 Apple Silicon Mac 和 x86_64 Linux。请在支持的设备上运行。</div>'
            : `
      ${stepOne}
      <div class="card"><h2>2 · 安装 Pi 安全环境</h2><p>环境：${esc(h.vm)} · Pi：${label(h.installed)}${h.runtime_version ? ' · 服务版本 ' + esc(h.runtime_version) : ''}</p>
      <p class="muted">独立 Linux 环境使用 4 GB 内存、最多 30 GB 虚拟磁盘；保留已有账户和工作区。</p>${versionNote}
      ${stepButton(h.installed ? '修复 / 更新 Pi' : '安装 Pi', 'setup-install', h.lima && h.python)}${h.vm === 'Stopped' ? button('启动环境', 'vm-start') : ''}
      </div>
      <div class="card"><h2>3 · 连接模型</h2><p>凭证库：${h.unlocked ? '已解锁' : '未解锁'} · 模型认证：${label(h.configured)}${h.model ? ' · ' + esc(h.model) : ''}</p>${expiry}
      <div class="actions">${stepButton('初始化 / 解锁', 'setup-unlock', h.installed)}${stepButton('使用已有 Codex 登录', 'setup-import', h.unlocked)}${stepButton('登录 / 重新认证', 'setup-login', h.unlocked && h.codex)}</div>
      <p class="muted">登录会打开系统浏览器。使用你的 ChatGPT 订阅，短期访问令牌保存在隔离认证层。到期后从这里重新认证，已连接的 Pi 不需要断开。请备份本机主密钥；详情见使用说明。</p>
      </div>
      <div class="card"><h2>4 · 完成第一个任务</h2><p>示例：把一段虚构项目计划整理为三条待办。不需要连接邮箱或授权目录。</p>
      <p class="caption">模型调用 · ${esc(modeText(state.rules?.inference))}</p>
      <div class="actions">${state.rules?.inference === 'ask' ? button('恢复模型调用持续授权', 'model-auto') : button('模型调用改为逐轮审批', 'model-ask')}</div>
      ${state.firstTask?.state === 'succeeded' || state.setup?.completedAt ? '<div class="note">首个任务已返回结果。你可以继续对话，或到「连接与权限」添加自己的资源。</div>' : state.firstTask?.state === 'failed' ? '<p class="error">任务未完成。检查模型认证和审批状态后重试。</p>' : ''}
      <div class="actions">${stepButton(state.connected ? 'Pi 已连接' : '连接 Pi', 'connect', h.configured && !state.connected)}${stepButton('开始示例任务', 'first-task', state.connected && !state.busy)}${button('查看待审批请求', 'approvals')}${button('查看结果', 'go-agent')}</div>
      <p class="muted">先连接 Pi，再开始任务。持续授权下模型请求自动放行并记入审计；改为逐轮审批后才会进入「独立审批」等待确认。</p>
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
          模型认证由隔离认证层托管。认证过期时在「首次设置」重新导入即可，不需要断开 Pi。
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
          maxlength="${Number(state.limits?.prompt_chars) || 8000}"
          placeholder="描述你希望完成的任务…"
          ${!state.connected || state.busy ? 'disabled' : ''}
        >
${esc(draft)}</textarea
        ><button class="primary" ${!state.connected || state.busy ? 'disabled' : ''}>发送</button>
      </form>
      <p class="caption">
        本地目录通过 host_files 工具访问；shell 仅能访问 cell 工作区。默认持续授权：
        读写与模型调用由策略自动放行并记入审计；可在「权限」中改为逐次审批。
      </p>`;
  } else if (page === 'permissions') {
    const catalog = Array.isArray(state.connectorCatalog) ? state.connectorCatalog : [];
    const statuses = state.connectors || {};
    const rules = state.rules || {};
    const cards = catalog
      .map((d) =>
        connectorCard(
          d,
          statuses[d.id],
          state.oauth?.pending && state.oauth?.connector === d.id,
          rules[d.id],
        ),
      )
      .join('');
    return /* HTML */ `<div class="eyebrow">PERMISSIONS</div>
      <h1>明确每一项访问范围</h1>
      <p class="muted">
        目录授权持续至撤销；重新打开应用时会先核对目录身份，只有同一目录才自动恢复。
      </p>
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
        ${state.directories.map((d) => `<div class="resource row"><div><strong>${esc(d.path.split('/').pop())}</strong> <span class="tag">${esc(directoryStatus(d))} · ${d.mode === 'ro' ? '只读' : '读写'}</span><div class="caption path">${esc(d.path)}</div></div><div class="actions">${d.status !== 'active' ? `<button data-activate="${esc(d.id)}">${d.reason && d.reason !== 'CONSENT_REQUIRED' ? '重新确认' : '启用授权'}</button>` : ''}<button data-mode="${esc(d.id)}" data-value="${d.mode === 'ro' ? 'rw' : 'ro'}">改为${d.mode === 'ro' ? '读写' : '只读'}</button><button data-remove="${esc(d.id)}">撤销并移除</button></div></div>`).join('') || '<p class="muted">尚未选择目录。建议原始资料只读、结果目录读写。</p>'}
        <p class="caption">
          支持最多 24 KB 的 UTF-8
          文本读写、创建子目录和删除普通文件。覆盖或删除的文件会移入该目录下隐藏的 .anchi-trash
          供你找回，Agent 看不到它。列表最多 100 项。拒绝隐藏路径、符号链接、硬链接和常见凭证目录。
        </p>
      </div>
      ${cards || '<div class="card"><p class="muted">正在载入连接器…</p></div>'}
      <p class="caption">
        凭证只由 VM
        认证层保存。默认连接即持续授权：读取、写入与模型调用由策略自动放行并记入审计；任一 connector
        可改为逐次审批。写入始终绑定目标修订并受每日次数上限。${statuses.vault_unlocked === false ? ' 凭证库已锁定，请先在首次设置解锁。' : ''}
      </p>`;
  } else if (page === 'approvals') {
    const summary = detail ? approvalSummary(detail.action) : [];
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
      ${
        detail
          ? `<div class="card"><h2>请求 ${esc(detail.id)}</h2><span class="tag">${esc(detail.state)}</span>${isWrite(detail.action?.operation) ? '<div class="write-banner">这是一次写入：批准后立即向外部服务写入下方内容。</div>' : ''}<p class="caption path">SHA-256：${esc(detail.digest)}</p>
        <dl class="kv">${summary.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}<dt>到期</dt><dd>${esc(clock(detail.expires))}</dd></dl>
        <p class="muted">下方为完整动作内容，可能包含将发送到模型的文件或邮件正文。请核对后决定。</p>
        <details><summary>完整 JSON</summary><pre>${esc(JSON.stringify(detail.action, null, 2))}</pre></details>
        <div class="actions">${detail.state === 'PENDING' ? button('批准这份请求', 'approve', 'primary') + button('拒绝', 'deny') : ''}${button('撤销', 'revoke')}</div></div>`
          : ''
      }`;
  } else {
    const rows = Array.isArray(audit) ? audit : null;
    return /* HTML */ `<div class="eyebrow">ACTIVITY</div>
      <h1>活动记录</h1>
      <p class="muted">
        桌面只保存事件类型、时间和标识，不保存聊天与审批正文；完整策略审计存于 VM，可在下方读取。
      </p>
      <div class="card">
        ${
          state.events
            .filter((e) => !['assistant', 'user', 'response'].includes(e.type))
            .slice()
            .reverse()
            .map(
              (e) =>
                `<div class="resource"><span class="tag">${esc(e.type)}</span> <span class="caption">${esc(e.time ? new Date(e.time).toLocaleString() : '')}</span> ${esc(e.text || e.error || e.tool || e.approval_id || '')} ${e.type === 'finished' ? esc(e.success ? '任务成功' : e.cancelled ? '任务取消' : '任务失败') : ''}</div>`,
            )
            .join('') || '尚无活动。'
        }
      </div>
      <div class="card">
        <div class="row">
          <h2>策略审计（VM）</h2>
          ${button('读取最近审计', 'audit')}
        </div>
        ${
          rows === null
            ? '<p class="muted">尚未读取。审计只含事件、时间、请求 ID 和内容摘要哈希。</p>'
            : rows.length
              ? rows
                  .map(
                    (r) =>
                      `<div class="resource"><span class="tag">${esc(r.event)}</span> <span class="caption">${esc(clock(r.at))}</span> ${esc(r.grant_id ? r.grant_id.slice(0, 12) : '')} <span class="caption path">${esc(r.digest ? r.digest.slice(0, 16) : '')}</span></div>`,
                  )
                  .join('')
              : '<p class="muted">VM 中还没有审计记录。</p>'
        }
      </div>`;
  }
}
