import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The proxy's certificate authority and the leaf certificates it signs for the hosts it
 * terminates TLS for. Node has no API to issue X.509 certificates, so the `openssl` command
 * line does it (LibreSSL on macOS, OpenSSL on Linux; only the options both have). One leaf key
 * serves every host; the certificates live a day and stay in memory.
 */
export class CertificateAuthority {
  readonly certFile: string;
  readonly keyFile: string;
  private readonly leafKeyFile: string;
  private readonly leaves = new Map<string, { cert: string; expires: number }>();
  private readonly pending = new Map<string, Promise<{ cert: string; key: string }>>();

  constructor(
    readonly dir: string,
    private readonly openssl = 'openssl',
  ) {
    this.certFile = join(dir, 'ca.pem');
    this.keyFile = join(dir, 'ca.key');
    this.leafKeyFile = join(dir, 'leaf.key');
  }

  /** Creates the CA and the leaf key once; a second start reuses them. */
  async ensure(): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    if (!existsSync(this.certFile) || !existsSync(this.keyFile)) {
      await run(this.openssl, [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        this.keyFile,
        '-out',
        this.certFile,
        '-days',
        '3650',
        '-subj',
        '/CN=Anchi host proxy CA/O=Anchi',
      ]);
      chmodSync(this.keyFile, 0o600);
    }
    if (!existsSync(this.leafKeyFile)) {
      await run(this.openssl, ['genrsa', '-out', this.leafKeyFile, '2048']);
      chmodSync(this.leafKeyFile, 0o600);
    }
  }

  certificate(): string {
    return readFileSync(this.certFile, 'utf8');
  }

  /** The leaf certificate and key for `host`, signed on first use and cached for a day. */
  leaf(host: string): Promise<{ cert: string; key: string }> {
    if (!/^[a-z0-9.-]{1,253}$/i.test(host)) return Promise.reject(new Error('BAD_HOST'));
    const cached = this.leaves.get(host);
    if (cached && cached.expires > Date.now())
      return Promise.resolve({ cert: cached.cert, key: readFileSync(this.leafKeyFile, 'utf8') });
    const pending = this.pending.get(host);
    if (pending) return pending;
    const work = this.sign(host).finally(() => this.pending.delete(host));
    this.pending.set(host, work);
    return work;
  }

  private async sign(host: string): Promise<{ cert: string; key: string }> {
    const base = join(this.dir, `leaf-${host.replace(/[^a-z0-9.-]/gi, '_')}`);
    const csr = `${base}.csr`;
    const ext = `${base}.ext`;
    const cert = `${base}.pem`;
    writeFileSync(
      ext,
      `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
      { mode: 0o600 },
    );
    await run(this.openssl, [
      'req',
      '-new',
      '-key',
      this.leafKeyFile,
      '-out',
      csr,
      '-subj',
      `/CN=${host}`,
    ]);
    await run(this.openssl, [
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      this.certFile,
      '-CAkey',
      this.keyFile,
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      '2',
      '-extfile',
      ext,
    ]);
    const pem = readFileSync(cert, 'utf8');
    this.leaves.set(host, { cert: pem, expires: Date.now() + 24 * 3600_000 });
    return { cert: pem, key: readFileSync(this.leafKeyFile, 'utf8') };
  }
}

/** The system's root certificates, which the CA is appended to for the sessions' tools. */
export function systemRoots(platform = process.platform): string {
  return platform === 'darwin' ? '/etc/ssl/cert.pem' : '/etc/ssl/certs/ca-certificates.crt';
}

/** Writes `file`: system roots plus the proxy's CA. */
export function writeBundle(
  ca: CertificateAuthority,
  file: string,
  rootsFile = systemRoots(),
): void {
  let roots = '';
  try {
    roots = readFileSync(rootsFile, 'utf8');
  } catch {
    // No system bundle at the usual path: the CA alone, which still lets the proxy's hosts verify.
  }
  const temporary = `${file}.new`;
  writeFileSync(temporary, `${roots.trimEnd()}\n${ca.certificate().trim()}\n`, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  // Rename, so a reader never sees a half-written bundle.
  renameSync(temporary, file);
}
