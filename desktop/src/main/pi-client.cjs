const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { validateCommand, Lines } = require('../shared/protocol.cjs');

/** Owns one RPC connection. Agent output never performs privileged host operations. */
class PiClient {
  constructor({
    runtime,
    files,
    notify,
    spawnProcess = spawn,
    responseTimeout = 20000,
    startupTimeout = 45000,
    stopTimeout = 5000,
  }) {
    Object.assign(this, {
      runtime,
      files,
      notify,
      spawnProcess,
      responseTimeout,
      startupTimeout,
      stopTimeout,
    });
    this.child = null;
    this.ready = false;
    this.starting = false;
    this.busy = false;
    this.sessionId = null;
    this.pending = new Map();
    this.stopping = null;
  }
  get state() {
    return {
      connected: this.ready,
      starting: this.starting,
      busy: this.busy,
      sessionId: this.sessionId,
    };
  }

  connect() {
    if (this.child || this.starting || this.stopping) return;
    this.starting = true;
    let proc;
    try {
      proc = this.spawnProcess(
        '/bin/bash',
        [path.join(this.runtime.root, 'scripts/pi.sh'), '--rpc', '--host-files'],
        { cwd: this.runtime.root, env: this.runtime.env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      this.starting = false;
      throw Error('PI_START_FAILED');
    }
    this.child = proc;
    const timer = setTimeout(() => {
      if (!this.ready && this.child === proc) {
        this.notify({ type: 'activity', text: 'Pi 启动超时，请检查安装与 cell 占用。' });
        void this.disconnect();
      }
    }, this.startupTimeout);
    const lines = new Lines(
      (value) => this.receive(value, timer),
      () => {
        this.notify({ type: 'protocol_error', error: 'INVALID_AGENT_STREAM' });
        void this.disconnect();
      },
    );
    proc.stdout.on('data', (chunk) => lines.push(chunk));
    proc.stderr.on('data', () => {}); // Diagnostics may contain sensitive environment data.
    proc.stdin.on('error', () => {});
    proc.on('error', () => {
      this.notify({ type: 'activity', text: 'Pi 连接进程启动失败。' });
    });
    proc.once('close', (code) => {
      clearTimeout(timer);
      if (this.child !== proc) return;
      this.child = null;
      this.ready = false;
      this.starting = false;
      this.busy = false;
      this.sessionId = null;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(Error('PI_DISCONNECTED'));
      }
      this.pending.clear();
      this.notify({ type: 'disconnected', code });
    });
  }

  receive(value, startupTimer) {
    if (value.type === 'host_file_request') {
      const child = this.child;
      if (
        !this.ready ||
        !this.files ||
        typeof value.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(value.id)
      )
        return;
      void this.files
        .request(value.request)
        .then(
          (result) => ({ ok: true, result }),
          (error) => ({
            ok: false,
            error: /^[A-Z_]+$/.test(error.message) ? error.message : 'FILE_OPERATION_DENIED',
          }),
        )
        .then((result) => {
          if (child === this.child && !child.stdin.destroyed && !child.stdin.writableEnded)
            child.stdin.write(
              JSON.stringify({ op: 'host_file_result', id: value.id, ...result }) + '\n',
            );
        });
      return;
    }
    if (value.type === 'ready') {
      if (value.protocol_version !== 1 || typeof value.session_id !== 'string')
        throw Error('INVALID_AGENT_STREAM');
      this.ready = true;
      this.starting = false;
      this.sessionId = value.session_id;
      clearTimeout(startupTimer);
    }
    if (value.type === 'response') {
      const entry = this.pending.get(value.id);
      // Unsolicited or late responses cannot mutate host-maintained session state.
      if (!entry || entry.op !== value.op) return;
      clearTimeout(entry.timer);
      this.pending.delete(value.id);
      if (value.ok) {
        if (typeof value.result?.session_id === 'string') this.sessionId = value.result.session_id;
        if (typeof value.result?.busy === 'boolean') this.busy = value.result.busy;
        if (entry.op === 'cancel') this.busy = false;
        entry.resolve(value.result);
      } else entry.reject(Error(/^[A-Z_]+$/.test(value.error) ? value.error : 'PI_REQUEST_FAILED'));
    }
    if (value.type === 'finished') this.busy = false;
    const allowed = [
      'ready',
      'response',
      'assistant',
      'approval_required',
      'tool_start',
      'tool_end',
      'finished',
      'turn_error',
      'protocol_error',
    ];
    if (allowed.includes(value.type)) this.notify(value);
  }

  request(op, args = {}) {
    return this.send(validateCommand(op, args));
  }

  send(value) {
    if (!this.child || !this.ready) return Promise.reject(Error('PI_NOT_CONNECTED'));
    if (this.pending.size >= 32) return Promise.reject(Error('PI_QUEUE_FULL'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('PI_RESPONSE_TIMEOUT'));
      }, this.responseTimeout);
      this.pending.set(id, { op: value.op, resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, ...value }) + '\n', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(Error('PI_INPUT_CLOSED'));
        }
      });
    });
  }

  disconnect() {
    if (this.stopping) return this.stopping;
    const proc = this.child;
    if (!proc) return Promise.resolve();
    this.stopping = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(terminate);
        clearTimeout(kill);
        resolve();
      };
      const terminate = setTimeout(() => proc.kill('SIGTERM'), this.stopTimeout);
      const kill = setTimeout(() => {
        proc.kill('SIGKILL');
        finish();
      }, this.stopTimeout * 2);
      proc.once('close', finish);
      // EOF cancels the remote controller too; no need to wait 20s for a close response.
      proc.stdin.end();
      if (proc.exitCode !== null) finish();
    }).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
}
module.exports = { PiClient };
