const { t } = require('./language.cjs');
const { validateCommand, LIMITS } = require('../shared/protocol.cjs');
const { CONNECTORS, byId, isConnector } = require('../shared/connectors.cjs');

const OPERATIONS = Object.freeze({
  snapshot: [],
  'set-language': ['locale'],
  'setup-status': [],
  'first-task': [],
  'setup-start': ['action'],
  'setup-cancel-login': [],
  'setup-dependency-installer': [],
  environment: [],
  'vm-start': [],
  connect: [],
  disconnect: [],
  rpc: ['op', 'args'],
  'directories-add': ['mode'],
  'directories-remove': ['id'],
  'directories-mode': ['id', 'mode'],
  'directories-activate': ['id'],
  'gmail-status': [],
  'gmail-import': [],
  'gmail-connect': [],
  'gmail-cancel': [],
  'gmail-disconnect': [],
  'gmail-read': ['mode'],
  'connector-status': ['connector'],
  'connector-connect': ['connector'],
  'connector-cancel': ['connector'],
  'connector-import-token': ['connector'],
  'connector-disconnect': ['connector'],
  'connector-read': ['connector', 'mode'],
  'connector-mode': ['connector', 'mode'],
  'model-mode': ['mode'],
  rules: [],
  approvals: [],
  audit: [],
  'approval-show': ['id'],
  'approval-decide': ['id', 'digest', 'decision'],
});
const EXCLUSIVE = new Set([
  'setup-start',
  'first-task',
  'connect',
  'directories-activate',
  'gmail-import',
  'gmail-connect',
  'gmail-cancel',
  'gmail-disconnect',
  'gmail-read',
  'connector-connect',
  'connector-cancel',
  'connector-import-token',
  'connector-disconnect',
  'connector-read',
  'connector-mode',
  'model-mode',
  'directories-add',
  'directories-remove',
  'directories-mode',
  'approval-decide',
  'vm-start',
]);

function validateHostCommand(op, args = {}) {
  if (typeof op !== 'string' || !Object.hasOwn(OPERATIONS, op)) throw Error('UNKNOWN_OPERATION');
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => !OPERATIONS[op].includes(k))
  )
    throw Error('INVALID_ARGUMENTS');
  if ('connector' in args && !isConnector(args.connector)) throw Error('INVALID_CONNECTOR');
  if (op === 'connector-read' && !['allow', 'deny'].includes(args.mode))
    throw Error('INVALID_MODE');
  if (['connector-mode', 'model-mode'].includes(op) && !['auto', 'ask'].includes(args.mode))
    throw Error('INVALID_MODE');
  if (op === 'set-language' && !['en', 'zh-CN'].includes(args.locale))
    throw Error('INVALID_LOCALE');
  return args;
}
function approvalId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/i.test(id)) throw Error('INVALID_APPROVAL_ID');
  return id;
}

/** Application use cases. Native dialogs and external services are injected for testing. */
class Controller {
  constructor({
    runtime,
    directories,
    pi,
    dialogs,
    notify,
    files,
    oauth,
    setup,
    preferences,
    onLanguageChange = () => {},
    version = '',
    log,
    tokens,
  }) {
    Object.assign(this, {
      runtime,
      directories,
      pi,
      dialogs,
      notify,
      files,
      oauth,
      setup,
      preferences,
      onLanguageChange,
      version,
      log,
      tokens,
    });
    this.events = log ? log.recent(200) : [];
    this.mutating = false;
    this.firstTask = null;
  }
  emit(event) {
    event = { ...event, time: event.time || new Date().toISOString() };
    if (this.firstTask?.state === 'running') {
      if (event.type === 'disconnected') this.firstTask.state = 'failed';
      if (
        event.turn_id === this.firstTask.turnId &&
        event.session_id === this.firstTask.sessionId
      ) {
        if (event.type === 'assistant' && event.text && !event.error)
          this.firstTask.hasReply = true;
        if (event.type === 'finished')
          this.firstTask.state = event.success && this.firstTask.hasReply ? 'succeeded' : 'failed';
      }
      if (this.firstTask.state === 'succeeded') void this.setup?.completed().catch(() => {});
    }
    this.events.push(event);
    if (this.events.length > 200) this.events.shift();
    void this.log?.append(event).catch(() => {});
    this.notify(event);
  }
  activity(text) {
    this.emit({ type: 'activity', text, time: new Date().toISOString() });
  }
  snapshot() {
    return {
      locale: this.preferences?.locale || 'en',
      root: this.runtime.root,
      version: this.version,
      limits: LIMITS,
      connectorCatalog: CONNECTORS,
      setup: this.setup
        ? { health: this.setup.health, job: this.setup.job, completedAt: this.setup.completedAt }
        : null,
      directories: this.directories.directories.map((d) => ({
        ...d,
        status: this.files?.grants.has(d.id) ? 'active' : 'pending',
        reason: this.files?.restoreErrors?.get(d.id) ?? null,
      })),
      firstTask: this.firstTask,
      oauth: this.oauth?.state,
      ...this.pi.state,
      events: this.events,
    };
  }

  async dispatch(op, args) {
    args = validateHostCommand(op, args);
    if (
      this.setup?.busy &&
      !['snapshot', 'set-language', 'setup-status', 'setup-cancel-login', 'disconnect'].includes(op)
    )
      throw Error('SETUP_IN_PROGRESS');
    const exclusive = EXCLUSIVE.has(op);
    if (exclusive && this.mutating) throw Error('ACTION_IN_PROGRESS');
    if (exclusive) this.mutating = true;
    try {
      return await this.handle(op, args);
    } finally {
      if (exclusive) this.mutating = false;
    }
  }

  async handle(op, args) {
    switch (op) {
      case 'set-language': {
        const result = await this.preferences.setLocale(args.locale);
        this.onLanguageChange(args.locale);
        return result;
      }
      case 'first-task': {
        if (!this.pi.state.connected || this.pi.state.busy) throw Error('PI_NOT_READY');
        if (this.firstTask?.state === 'running') throw Error('FIRST_TASK_RUNNING');
        await this.pi.request('new');
        const text = t(
          '这是首次使用的示例任务。仅根据以下虚构文本，整理成三条待办清单，不要调用任何工具：周一整理项目需求，周二写出设计初稿，周三与团队评审。',
        );
        const result = await this.pi.request('prompt', { text });
        this.firstTask = {
          state: 'running',
          turnId: result.turn_id,
          sessionId: this.pi.sessionId,
          hasReply: false,
        };
        this.emit({ type: 'user', text, session_id: this.pi.sessionId });
        return this.snapshot();
      }
      case 'setup-status':
        return this.setup.inspect();
      case 'setup-dependency-installer':
        await this.dialogs.openDependencyInstaller();
        return { opened: true };
      case 'setup-cancel-login':
        this.setup.cancelLogin();
        return { cancelling: true };
      case 'setup-start':
        if (!['dependencies', 'install', 'unlock', 'login', 'import'].includes(args.action))
          throw Error('INVALID_SETUP_ACTION');
        // Rebuilding the environment needs the cell idle; credential refresh does not.
        if (this.pi.child && ['dependencies', 'install'].includes(args.action))
          throw Error('DISCONNECT_PI_FIRST');
        if (!(await this.dialogs.confirmSetup(args.action))) return { cancelled: true };
        return this.setup.start(args.action);
      case 'snapshot':
        return this.snapshot();
      case 'environment':
        return this.runtime.inspect();
      case 'vm-start':
        await this.runtime.start();
        this.activity('已有 secure-vm 已启动');
        return this.snapshot();
      case 'connect':
        this.pi.connect();
        return this.snapshot();
      case 'disconnect':
        await this.pi.disconnect();
        return this.snapshot();
      case 'rpc': {
        const { op: rpcOp, ...rest } = validateCommand(args.op, args.args);
        const result = await this.pi.request(rpcOp, rest);
        if (rpcOp === 'prompt')
          this.emit({ type: 'user', text: rest.text, session_id: this.pi.sessionId });
        if (rpcOp === 'cancel')
          this.activity('已停止本地任务。待审批记录仍需拒绝/撤销，在途远端操作不会回滚。');
        return result;
      }
      case 'directories-add': {
        if (!['ro', 'rw'].includes(args.mode)) throw Error('INVALID_MODE');
        const file = await this.dialogs.chooseDirectory();
        if (file && (await this.dialogs.confirmDirectory({ path: file, mode: args.mode }))) {
          await this.directories.add(file, args.mode);
          await this.files.activate(this.directories.directories.at(-1).id);
          this.activity('目录授权已生效；可通过 host_files 工具访问。');
        }
        return this.snapshot();
      }
      case 'directories-activate': {
        const item = this.directories.directories.find((d) => d.id === args.id);
        if (!item) throw Error('DIRECTORY_NOT_FOUND');
        if (await this.dialogs.confirmDirectory(item)) await this.files.activate(args.id);
        return this.snapshot();
      }
      case 'directories-remove':
        await this.files.revoke(args.id);
        await this.directories.remove(args.id);
        break;
      case 'directories-mode':
        if (!['ro', 'rw'].includes(args.mode)) throw Error('INVALID_MODE');
        const item = this.directories.directories.find((d) => d.id === args.id);
        if (!item) throw Error('DIRECTORY_NOT_FOUND');
        if (!(await this.dialogs.confirmDirectory({ ...item, mode: args.mode })))
          return this.snapshot();
        await this.files.revoke(args.id);
        await this.directories.update(args.id, args.mode);
        await this.files.activate(args.id);
        break;
      // Gmail-specific operations stay one release as aliases of the connector operations.
      case 'gmail-status':
        return this.oauth.status();
      case 'gmail-import': {
        const value = await this.dialogs.chooseClient();
        if (value) await this.runtime.auth('import-client', value);
        return this.oauth.status();
      }
      case 'gmail-connect':
        return this.connector('connect', { connector: 'gmail' });
      case 'gmail-cancel':
        return this.connector('cancel', { connector: 'gmail' });
      case 'gmail-read':
        if (!['allow', 'deny'].includes(args.mode)) throw Error('INVALID_MODE');
        return this.connector('read', { connector: 'gmail', mode: args.mode });
      case 'gmail-disconnect':
        return this.connector('disconnect', { connector: 'gmail' });
      case 'connector-status':
        return this.oauth.status();
      case 'connector-connect':
      case 'connector-cancel':
      case 'connector-import-token':
      case 'connector-disconnect':
      case 'connector-read':
      case 'connector-mode':
        return this.connector(op.slice('connector-'.length), args);
      case 'model-mode':
        if (args.mode === 'auto' && !(await this.dialogs.confirmStanding({ label: '模型调用' })))
          return { cancelled: true };
        return this.runtime.policy('mode', 'inference', args.mode);
      case 'rules':
        return this.runtime.policy('rules');
      case 'approvals':
        return this.runtime.policy('pending');
      case 'audit':
        return this.runtime.policy('audit', '--limit', '200');
      case 'approval-show':
        return this.runtime.policy('show', approvalId(args.id));
      case 'approval-decide':
        return this.decide(args);
      default:
        throw Error('UNKNOWN_OPERATION');
    }
    this.activity('目录权限已更新，撤销前已开始的操作已结束。');
    return this.snapshot();
  }

  /** Connector lifecycle. Google connectors use loopback OAuth; token connectors use the token window. */
  async connector(action, args) {
    const descriptor = byId(args.connector);
    switch (action) {
      case 'connect':
        if (descriptor.auth !== 'google') throw Error('OAUTH_NOT_APPLICABLE');
        return this.oauth.begin(args.connector);
      case 'cancel':
        await this.oauth.cancel();
        return this.oauth.status();
      case 'import-token': {
        if (descriptor.auth !== 'token') throw Error('TOKEN_NOT_APPLICABLE');
        const token = await this.tokens.prompt(descriptor);
        if (!token) return { cancelled: true };
        await this.runtime.auth('import-token', { token }, args.connector);
        try {
          await this.runtime.connectorAdmin(args.connector, 'probe');
        } catch {
          this.activity(`${descriptor.label} 已保存令牌，但账户探测失败，显示为未验证。`);
        }
        this.activity(`${descriptor.label} 令牌已导入。`);
        return this.oauth.status();
      }
      case 'read':
        // Legacy alias: allow -> standing authorization, deny -> per-request approval.
        return this.connector('mode', {
          connector: args.connector,
          mode: args.mode === 'allow' ? 'auto' : 'ask',
        });
      case 'mode':
        if (args.mode === 'auto' && !(await this.dialogs.confirmStanding(descriptor)))
          return { cancelled: true };
        return this.runtime.policy('mode', args.connector, args.mode);
      case 'disconnect': {
        if (!(await this.dialogs.confirmDisconnect(descriptor))) return { cancelled: true };
        await this.oauth.cancel().catch(() => {});
        // Re-applying the current mode bumps the policy epoch and revokes every outstanding grant.
        const rules = (await this.runtime.policy('rules')).rules || {};
        await this.runtime.policy('mode', args.connector, rules[args.connector] || 'auto');
        if (args.connector === 'gmail') {
          await this.pi.disconnect();
          return this.runtime.auth('disconnect', {}, 'gmail');
        }
        const result = await this.runtime.connectorAdmin(args.connector, 'disconnect');
        this.activity(
          `${descriptor.label} 已断开${result.remote_revoked ? '，远端令牌已撤销' : ''}。`,
        );
        return result;
      }
      default:
        throw Error('UNKNOWN_OPERATION');
    }
  }

  async decide(args) {
    const id = approvalId(args.id);
    if (!['approve', 'deny', 'revoke'].includes(args.decision)) throw Error('INVALID_DECISION');
    const detail = await this.runtime.policy('show', id);
    if (
      args.decision === 'approve' &&
      (typeof args.digest !== 'string' ||
        args.digest !== detail.digest ||
        detail.state !== 'PENDING')
    )
      throw Error('APPROVAL_CHANGED');
    if (!(await this.dialogs.confirmApproval({ id, decision: args.decision, detail })))
      return { cancelled: true };
    // Policy service atomically validates state/digest/expiry again at commit time.
    const result = await this.runtime.policy(
      args.decision,
      id,
      ...(args.decision === 'approve' ? ['--digest', detail.digest] : []),
    );
    this.activity(`审批 ${id}：${args.decision}`);
    return result;
  }
}
module.exports = { Controller, validateHostCommand };
