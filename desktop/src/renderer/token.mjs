// Token entry page: no agent content is ever rendered here. Hints mirror shared/connectors.cjs
// (a test keeps them identical) because this ES module cannot import the CommonJS descriptor.
const HINTS = {
  notion: {
    label: 'Notion',
    hint: '打开 app.notion.com/developers/connections（需为工作区 Owner），在 Internal connections 新建连接，Configuration 里勾选读取、插入、更新内容并复制 Installation access token（ntn_ 开头），再把测试页面共享给该连接。',
    pattern: '^(ntn_|secret_)[A-Za-z0-9_-]{30,190}$',
  },
  slack: {
    label: 'Slack',
    hint: '在 api.slack.com 创建应用并安装到工作区，复制以 xoxb- 开头的 Bot User OAuth Token。',
    pattern: '^xoxb-[A-Za-z0-9-]{30,190}$',
  },
};
const connector = new URLSearchParams(location.search).get('connector');
const spec = HINTS[connector];
const $ = (s) => document.querySelector(s);
if (spec) {
  $('#title').textContent = `输入 ${spec.label} 令牌`;
  $('#hint').textContent = spec.hint;
}
document.querySelector('[data-cancel]').addEventListener('click', () => {
  void window.desktop.submitToken(null);
});
$('#token-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('#token').value.trim();
  if (!spec || !new RegExp(spec.pattern).test(value)) {
    $('#token-error').textContent = '令牌格式不正确，请检查前缀与长度。';
    return;
  }
  window.desktop.submitToken(value).catch(() => {
    $('#token-error').textContent = '保存失败，请重试。';
  });
});
