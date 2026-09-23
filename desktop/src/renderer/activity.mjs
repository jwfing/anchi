const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const tools = new Map([
  ['bash', 'Shell 命令'],
  ['notion_search', 'Notion 搜索'],
  ['drive_search', 'Google Drive 搜索'],
  ['gmail_read', '读取 Gmail 邮件'],
  ['gmail_search', 'Gmail 搜索'],
  ['host_files', '本地文件操作'],
]);
const types = new Map([
  ['ready', 'Pi 已连接，可以开始任务'],
  ['disconnected', 'Pi 已断开连接'],
  ['connectors_changed', '连接器状态已更新'],
  ['gmail_changed', 'Gmail 连接状态已更新'],
  ['setup_changed', '环境设置状态已更新'],
  ['approval_required', '有请求需要审批'],
  ['turn_error', '任务执行异常'],
  ['protocol_error', 'Agent 通信异常'],
]);
export function describeActivity(event) {
  let title = types.get(event.type) || '其他活动',
    tone = 'neutral',
    label = '记录';
  const tool = tools.get(event.tool) || event.tool || '工具';
  if (event.type === 'finished') {
    if (event.cancelled) {
      title = '任务已取消';
      tone = 'warning';
      label = '已取消';
    } else if (event.success === true) {
      title = '任务已完成';
      tone = 'success';
      label = '成功';
    } else if (event.success === false) {
      title = '任务失败';
      tone = 'error';
      label = '失败';
    } else {
      title = '任务已结束';
      label = '已结束';
    }
  } else if (event.type === 'tool_start') {
    title = `开始：${tool}`;
    label = '开始';
  } else if (event.type === 'tool_end') {
    title = `${tool} · ${event.is_error === true ? '执行失败' : '执行结束'}`;
    tone = event.is_error === true ? 'error' : 'neutral';
    label = event.is_error === true ? '失败' : '结束';
  } else if (event.type === 'approval_required') {
    tone = 'warning';
    label = '需审批';
  } else if (['turn_error', 'protocol_error'].includes(event.type)) {
    tone = 'error';
    label = '异常';
  } else if (event.type === 'activity') {
    const decision = /^审批\s+(\S+)[：:]\s*(approve|deny|revoke)$/.exec(event.text || '');
    if (decision) {
      title = { approve: '审批请求已批准', deny: '审批请求已拒绝', revoke: '审批授权已撤销' }[
        decision[2]
      ];
      tone = decision[2] === 'approve' ? 'success' : 'warning';
      label = '审批';
      return { title, tone, label, approvalId: decision[1] };
    }
    title = event.text || '活动已记录';
  }
  return { title, tone, label, approvalId: event.approval_id };
}
export function renderActivity(events = []) {
  const items = events
    .filter((e) => !['assistant', 'user', 'response'].includes(e.type))
    .slice()
    .reverse();
  if (!items.length)
    return '<p class="muted">尚无活动。连接 Pi 并开始任务后，记录会显示在这里。</p>';
  const groups = new Map();
  for (const event of items) {
    const date = event.time ? new Date(event.time) : null;
    const valid = date && Number.isFinite(date.getTime());
    const day = valid
      ? date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
      : '时间未知';
    if (!groups.has(day)) groups.set(day, []);
    const { title, tone, label, approvalId } = describeActivity(event);
    const fields = [
      ['事件', event.type],
      ['工具', event.tool],
      ['审批 ID', approvalId],
      ['时间', event.time],
      ['错误', event.error],
      ['错误代码', event.code],
    ].filter(([, value]) => value !== undefined && value !== '');
    const time = valid
      ? date.toLocaleTimeString('zh-CN', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : '未知时间';
    groups
      .get(day)
      .push(
        `<li class="activity-item"><span class="activity-time">${escape(time)}</span><div class="activity-content"><div class="activity-line"><span class="activity-badge activity-${tone}">${label}</span><strong>${escape(title)}</strong></div><details class="activity-details"><summary>详情</summary><dl class="kv">${fields.map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join('')}</dl></details></div></li>`,
      );
  }
  return `<p class="caption">最近 ${items.length} 条活动 · 最新在前 · 本地时间</p>${[...groups].map(([day, rows]) => `<section class="activity-day"><h2>${day}</h2><ol class="activity-list">${rows.join('')}</ol></section>`).join('')}`;
}
