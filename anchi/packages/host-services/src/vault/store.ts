import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { checkName, decrypt, encrypt, VaultError } from './envelope.ts';

/**
 * Encrypted credential files under one directory (mode 0700, files 0600), with the master key
 * held in this process's memory only while unlocked: never written on the host. A wrong key
 * never replaces a working one, since `unlock` decrypts every stored file first.
 */
export class Vault {
  private master: Buffer | null = null;

  constructor(readonly dir: string) {}

  get unlocked(): boolean {
    return this.master !== null;
  }

  status(): { unlocked: boolean; encrypted_files: number } {
    return { unlocked: this.unlocked, encrypted_files: this.encryptedNames().length };
  }

  private encryptedNames(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json.enc'))
        .map((f) => f.slice(0, -4));
    } catch {
      return [];
    }
  }

  /** Accepts the key only when every stored file decrypts with it. */
  unlock(keyBase64: string): void {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new VaultError('VAULT_KEY_INVALID');
    for (const name of this.encryptedNames()) decrypt(name, this.readEnvelope(name), key);
    this.master = key;
  }

  lock(): void {
    this.master?.fill(0);
    this.master = null;
  }

  private key(): Buffer {
    if (this.master === null) throw new VaultError('VAULT_LOCKED');
    return this.master;
  }

  private path(name: string): string {
    return join(this.dir, `${checkName(name)}.enc`);
  }

  private readEnvelope(name: string): unknown {
    const path = this.path(name);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new VaultError('NOT_CONNECTED');
      throw new VaultError('VAULT_INTEGRITY_ERROR');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new VaultError('VAULT_INTEGRITY_ERROR');
    }
  }

  exists(name: string): boolean {
    const path = this.path(name);
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  }

  read(name: string): Record<string, unknown> {
    const key = this.key();
    const value = decrypt(name, this.readEnvelope(name), key);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new VaultError('VAULT_INTEGRITY_ERROR');
    return value as Record<string, unknown>;
  }

  /** Written through a temporary file, synced, then renamed: a crash leaves the old file. */
  write(name: string, value: Record<string, unknown>): void {
    const envelope = encrypt(name, value, this.key());
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = this.path(name);
    const temporary = join(this.dir, `.encrypted-${process.pid}-${Date.now()}`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(envelope));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
    const dir = openSync(this.dir, 'r');
    try {
      fsyncSync(dir);
    } catch {
      // Directory fsync is best effort on some file systems.
    } finally {
      closeSync(dir);
    }
  }

  remove(name: string): void {
    rmSync(this.path(name), { force: true });
  }
}
