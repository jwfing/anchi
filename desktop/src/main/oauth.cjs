const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { GOOGLE_SCOPES } = require('../shared/connectors.cjs');
function same(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function validateAuthorization(flow, redirect, scopes = GOOGLE_SCOPES.gmail) {
  const url = new URL(flow.url);
  const granted = (url.searchParams.get('scope') || '').split(' ').filter(Boolean).sort();
  if (
    url.origin !== 'https://accounts.google.com' ||
    url.pathname !== '/o/oauth2/v2/auth' ||
    url.username ||
    url.password ||
    url.hash ||
    !same(url.searchParams.get('state'), flow.state) ||
    typeof flow.state !== 'string' ||
    flow.state.length < 32 ||
    url.searchParams.get('redirect_uri') !== redirect ||
    url.searchParams.get('code_challenge_method') !== 'S256' ||
    granted.join(' ') !== [...scopes].sort().join(' ') ||
    url.searchParams.get('response_type') !== 'code'
  )
    throw Error('INVALID_AUTHORIZATION_URL');
  return url.href;
}
class DesktopOAuth {
  constructor({ runtime, openExternal, notify, timeout = 590000 }) {
    Object.assign(this, { runtime, openExternal, notify, timeout });
    this.flow = null;
    this.state = { pending: false };
  }
  async status() {
    return { ...(await this.runtime.auth('status')), ...this.state };
  }
  async begin(connector = 'gmail') {
    if (this.flow) throw Error('OAUTH_IN_PROGRESS');
    if (!GOOGLE_SCOPES[connector]) throw Error('OAUTH_NOT_APPLICABLE');
    const flow = { server: http.createServer(), consumed: false, connector };
    this.flow = flow;
    this.state = { pending: true, connector };
    flow.server.requestTimeout = 5000;
    flow.server.headersTimeout = 5000;
    flow.server.maxHeadersCount = 30;
    flow.server.on('request', (req, res) => {
      void this.callback(flow, req, res);
    });
    try {
      await new Promise((resolve, reject) => {
        flow.server.once('error', reject);
        flow.server.listen(0, '127.0.0.1', resolve);
      });
      flow.host = `127.0.0.1:${flow.server.address().port}`;
      const redirect = `http://${flow.host}/callback`;
      const auth = await this.runtime.auth('begin', { redirect_uri: redirect }, connector);
      if (this.flow !== flow) throw Error('OAUTH_CANCELLED');
      flow.state = auth.state;
      const url = validateAuthorization(auth, redirect, GOOGLE_SCOPES[connector]);
      flow.timer = setTimeout(() => {
        void this.cancel()
          .catch(() => {})
          .finally(() => this.notify({ type: 'activity', text: 'Google 授权已超时。' }));
      }, this.timeout);
      await this.openExternal(url);
      return { pending: true };
    } catch (error) {
      await this.cancel().catch(() => {});
      throw error;
    }
  }
  async callback(flow, req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    let url;
    try {
      url = new URL(req.url, `http://${flow.host}`);
    } catch {
      res.writeHead(400).end('Invalid callback');
      return;
    }
    if (
      req.method !== 'GET' ||
      req.headers.host !== flow.host ||
      url.origin !== `http://${flow.host}` ||
      url.pathname !== '/callback' ||
      flow !== this.flow ||
      flow.consumed ||
      url.searchParams.getAll('state').length !== 1 ||
      !same(url.searchParams.get('state'), flow.state)
    ) {
      res.writeHead(400).end('Invalid callback');
      return;
    }
    const code = url.searchParams.get('code');
    if (
      !url.searchParams.has('error') &&
      (url.searchParams.getAll('code').length !== 1 || !code || code.length > 4096)
    ) {
      res.writeHead(400).end('Invalid code');
      return;
    }
    flow.consumed = true;
    clearTimeout(flow.timer);
    res.end('可以关闭此页面，返回安栖查看连接结果。');
    flow.server.close();
    try {
      if (url.searchParams.has('error')) throw Error('OAUTH_CANCELLED');
      await this.runtime.auth('complete', { code, state: flow.state }, flow.connector);
      this.notify({
        type: 'activity',
        text: `${flow.connector} 已连接。Agent 的读取仍由独立策略控制。`,
      });
      // Account label is fetched with the connector's own identity; failure only affects the label.
      await this.runtime.connectorAdmin?.(flow.connector, 'probe').catch(() => {});
    } catch {
      await this.runtime.auth('cancel', {}, flow.connector).catch(() => {});
      this.notify({
        type: 'activity',
        text: 'Google 授权未完成，请重新连接并检查凭证库是否解锁。',
      });
    } finally {
      if (this.flow === flow) {
        this.flow = null;
        this.state = { pending: false };
      }
      this.notify({ type: 'connectors_changed', connector: flow.connector });
    }
  }
  async cancel() {
    const flow = this.flow;
    if (!flow) return;
    if (flow.consumed) throw Error('OAUTH_COMPLETING');
    this.flow = null;
    this.state = { pending: false };
    clearTimeout(flow.timer);
    flow.server.close();
    flow.server.closeAllConnections();
    await this.runtime.auth('cancel', {}, flow.connector);
  }
}
module.exports = { DesktopOAuth, validateAuthorization };
