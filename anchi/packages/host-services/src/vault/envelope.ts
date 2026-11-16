import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The vault's file format, byte-compatible with services/vault.py: AES-256-GCM, a 12-byte
 * nonce, the logical file name as associated data (`secure-vm:v1:<name>`), base64 fields. A
 * file written by either implementation decrypts in the other, so a host placement set up with
 * the Python vault keeps its credentials.
 */

export const NAMES: ReadonlySet<string> = new Set([
  'client.json',
  'reddit-client.json',
  'reddit-tokens.json',
  'reddit-pending.json',
  'reddit-revocation.json',
  'x-client.json',
  'x-tokens.json',
  'x-pending.json',
  'x-revocation.json',
  'tokens.json',
  'pending.json',
  'revocation.json',
  'drive-tokens.json',
  'drive-pending.json',
  'drive-revocation.json',
  'notion.json',
  'slack.json',
  'model.json',
  'codex.json',
  'claude.json',
  'hermes.json',
  'github.json',
  'linear.json',
  'posthog.json',
  'sentry.json',
  'firecrawl.json',
  'figma.json',
  'discord.json',
  'aws.json',
]);
const ACCOUNT_NAME =
  /^(tokens|pending|revocation|drive-tokens|drive-pending|drive-revocation)\.[a-z0-9][a-z0-9_-]{0,31}\.json$/;

export class VaultError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'VaultError';
  }
}

export interface Envelope {
  version: 1;
  nonce: string;
  ciphertext: string;
}

export function checkName(name: string): string {
  if (!NAMES.has(name) && !ACCOUNT_NAME.test(name)) throw new VaultError('VAULT_NAME_DENIED');
  return name;
}

const aad = (name: string) => Buffer.from(`secure-vm:v1:${name}`, 'utf8');

export function encrypt(name: string, value: unknown, master: Buffer, nonce?: Buffer): Envelope {
  const iv = nonce ?? randomNonce();
  const cipher = createCipheriv('aes-256-gcm', master, iv);
  cipher.setAAD(aad(name));
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
    cipher.final(),
  ]);
  // Python's AESGCM appends the 16-byte tag to the ciphertext.
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
  return { version: 1, nonce: iv.toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function decrypt(name: string, envelope: unknown, master: Buffer): unknown {
  try {
    const e = envelope as Envelope;
    if (!e || typeof e !== 'object' || e.version !== 1) throw new Error();
    const nonce = strictBase64(e.nonce);
    const data = strictBase64(e.ciphertext);
    if (nonce.length !== 12 || data.length < 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', master, nonce);
    decipher.setAAD(aad(name));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new VaultError('VAULT_INTEGRITY_ERROR');
  }
}

function randomNonce(): Buffer {
  return randomBytes(12);
}

/** Base64 as Python's `validate=True` reads it: no stray characters, correct padding. */
function strictBase64(text: unknown): Buffer {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
    throw new Error();
  return Buffer.from(text, 'base64');
}
