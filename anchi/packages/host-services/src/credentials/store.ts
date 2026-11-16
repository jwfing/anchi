import { randomBytes } from 'node:crypto';
import { ControlError } from '../control/protocol.ts';
import type { Vault } from '../vault/store.ts';
import { VaultError } from '../vault/envelope.ts';

/**
 * The connector credentials a host placement keeps: static tokens the user pastes (validated
 * by shape only), and one AWS principal. Files, fields and status shapes follow
 * services/auth.py so the daemon reads both the same way.
 */

export const TOKENS: Record<string, { file: string; pattern: RegExp }> = {
  github: { file: 'github.json', pattern: /^(ghp_|gho_|ghu_|github_pat_)[A-Za-z0-9_]{20,255}$/ },
  linear: { file: 'linear.json', pattern: /^lin_api_[A-Za-z0-9]{20,100}$/ },
  posthog: { file: 'posthog.json', pattern: /^phx_[A-Za-z0-9]{20,100}$/ },
  // A user auth token, or a legacy one without prefix; organization tokens cannot read the API.
  sentry: { file: 'sentry.json', pattern: /^(sntryu_)?[a-f0-9]{64}$/ },
  firecrawl: { file: 'firecrawl.json', pattern: /^fc-[A-Za-z0-9]{20,100}$/ },
  figma: { file: 'figma.json', pattern: /^figd_[A-Za-z0-9_-]{20,200}$/ },
  // A bot token: user id, timestamp and signature, base64url, separated by dots.
  discord: {
    file: 'discord.json',
    pattern: /^[A-Za-z0-9_-]{18,40}\.[A-Za-z0-9_-]{4,10}\.[A-Za-z0-9_-]{20,80}$/,
  },
};
export const AWS_FILE = 'aws.json';
const AWS_KEY_ID = /^(AKIA|ASIA)[A-Z0-9]{12,124}$/;
const AWS_REGION = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/;
/** Connectors whose credentials the egress proxy may read. */
export const EGRESS_CONNECTORS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(TOKENS).map(([c, spec]) => [c, spec.file])),
  aws: AWS_FILE,
};

export interface ConnectorStatus {
  connected: boolean;
  reauth_required: boolean;
  account: string | null;
  scope_text: string;
  revocation_pending: boolean;
  auth: 'token' | 'aws';
}

export class CredentialStore {
  constructor(private vault: Vault) {}

  private label(
    file: string,
    fallback?: (value: Record<string, unknown>) => string | null,
  ): string | null {
    if (!this.vault.unlocked) return null;
    try {
      const value = this.vault.read(file);
      const account = value.account;
      if (typeof account === 'string') return account;
      return fallback?.(value) ?? null;
    } catch (err) {
      if (err instanceof VaultError) return null;
      throw err;
    }
  }

  connectorStatus(connector: string): ConnectorStatus {
    if (connector === 'aws') {
      const connected = this.vault.exists(AWS_FILE);
      return {
        connected,
        reauth_required: false,
        account: connected
          ? this.label(AWS_FILE, (v) => {
              const id = String(v.access_key_id ?? '');
              return `${id.slice(0, 4)}…${id.slice(-4)}`;
            })
          : null,
        scope_text: '',
        revocation_pending: false,
        auth: 'aws',
      };
    }
    const spec = TOKENS[connector];
    if (!spec) throw new ControlError('UNKNOWN_CONNECTOR');
    const connected = this.vault.exists(spec.file);
    return {
      connected,
      reauth_required: false,
      account: connected ? this.label(spec.file) : null,
      scope_text: '',
      revocation_pending: false,
      auth: 'token',
    };
  }

  /** Every connector's status, no secrets: what `admin.py status` returns for these. */
  status(): Record<string, ConnectorStatus> {
    const out: Record<string, ConnectorStatus> = {};
    for (const connector of [...Object.keys(TOKENS), 'aws'])
      out[connector] = this.connectorStatus(connector);
    return out;
  }

  importToken(connector: string, token: string): ConnectorStatus {
    const spec = TOKENS[connector];
    if (!spec) throw new ControlError('UNKNOWN_CONNECTOR');
    if (!spec.pattern.test(token)) throw new ControlError('BAD_TOKEN_FORMAT');
    this.vault.write(spec.file, {
      token,
      generation: randomBytes(16).toString('hex'),
      imported_at: Date.now() / 1000,
    });
    return this.connectorStatus(connector);
  }

  /** A dedicated least-privilege principal's keys; the proxy re-signs requests with them. */
  importAws(value: {
    access_key_id: string;
    secret_access_key: string;
    session_token?: string;
    region: string;
  }): ConnectorStatus {
    const {
      access_key_id: keyId,
      secret_access_key: secret,
      session_token: session,
      region,
    } = value;
    if (!AWS_KEY_ID.test(keyId)) throw new ControlError('BAD_AWS_ACCESS_KEY_ID');
    if (!/^[A-Za-z0-9/+=]{20,128}$/.test(secret)) throw new ControlError('BAD_AWS_SECRET');
    if (session !== undefined && !/^[A-Za-z0-9/+=]{16,4096}$/.test(session))
      throw new ControlError('BAD_AWS_SESSION_TOKEN');
    if (keyId.startsWith('ASIA') !== (session !== undefined))
      throw new ControlError('AWS_SESSION_TOKEN_MISMATCH');
    if (!AWS_REGION.test(region)) throw new ControlError('BAD_AWS_REGION');
    const stored: Record<string, unknown> = {
      access_key_id: keyId,
      secret_access_key: secret,
      region,
      generation: randomBytes(16).toString('hex'),
      imported_at: Date.now() / 1000,
    };
    if (session !== undefined) stored.session_token = session;
    this.vault.write(AWS_FILE, stored);
    return this.connectorStatus('aws');
  }

  remove(connector: string): ConnectorStatus {
    const file = EGRESS_CONNECTORS[connector];
    if (!file) throw new ControlError('UNKNOWN_CONNECTOR');
    this.vault.remove(file);
    return this.connectorStatus(connector);
  }

  setAccount(connector: string, label: string): ConnectorStatus {
    const file = EGRESS_CONNECTORS[connector];
    if (!file) throw new ControlError('UNKNOWN_CONNECTOR');
    if (!label || label.length > 200) throw new ControlError('BAD_ACCOUNT_LABEL');
    const value = this.vault.read(file);
    value.account = label;
    this.vault.write(file, value);
    return this.connectorStatus(connector);
  }

  /** Credential the proxy injects for one connector; secrets only, no labels. */
  egressCredential(connector: string): Record<string, unknown> {
    const file = EGRESS_CONNECTORS[connector];
    if (!file) throw new ControlError('UNKNOWN_CONNECTOR');
    const value = this.vault.read(file);
    const keys =
      connector === 'aws'
        ? ['access_key_id', 'secret_access_key', 'session_token', 'region']
        : ['token'];
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in value) out[k] = value[k];
    out.generation = value.generation;
    return out;
  }
}
