/**
 * Display and validation facts for each connector. The trusted policy (hosts, operations,
 * credentials) lives in services/connectors.py; a consistency test keeps the ids aligned.
 */
const CONNECTORS = Object.freeze([
  {
    id: 'gmail',
    label: 'Gmail',
    auth: 'google',
    scopeText: '只读邮件（gmail.readonly）',
    dataText: '邮件内容可能进入 agent 上下文与云模型。',
    tokenHint: null,
    tokenPattern: null,
  },
  {
    id: 'drive',
    label: 'Google Drive',
    auth: 'google',
    scopeText: '读取全部文件；新建文件；只能更新由本应用创建的文件（drive.readonly + drive.file）',
    dataText: '文件正文可能进入 agent 上下文与云模型；更新绑定目标修订。',
    tokenHint: null,
    tokenPattern: null,
  },
  {
    id: 'notion',
    label: 'Notion',
    auth: 'token',
    scopeText: '内部集成令牌；只能访问你在 Notion 中共享给该集成的页面',
    dataText: '页面内容可能进入 agent 上下文与云模型；追加绑定页面编辑时间。',
    tokenHint:
      '打开 app.notion.com/developers/connections（需为工作区 Owner），在 Internal connections 新建连接，Configuration 里勾选读取、插入、更新内容并复制 Installation access token（ntn_ 开头），再把测试页面共享给该连接。',
    tokenPattern: '^(ntn_|secret_)[A-Za-z0-9_-]{30,190}$',
  },
  {
    id: 'slack',
    label: 'Slack',
    auth: 'token',
    scopeText:
      'Bot 令牌，需 channels:read、channels:history、groups:read、groups:history、chat:write；只能读取 bot 已加入的频道',
    dataText: '频道消息可能进入 agent 上下文与云模型；发消息受每日次数上限。',
    tokenHint:
      '在 api.slack.com 创建应用并安装到工作区，复制以 xoxb- 开头的 Bot User OAuth Token。',
    tokenPattern: '^xoxb-[A-Za-z0-9-]{30,190}$',
  },
]);
const GOOGLE_SCOPES = Object.freeze({
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
  drive: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
  ],
});
const byId = (id) => CONNECTORS.find((c) => c.id === id) || null;
const isConnector = (id) => byId(id) !== null;
module.exports = { CONNECTORS, GOOGLE_SCOPES, byId, isConnector };
