import { mkdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ControlServer } from './control/server.ts';
import { type HostServicesPaths, hostServicesPaths } from './paths.ts';
import { ControlError, type ControlRequest } from './control/protocol.ts';
import { CredentialStore } from './credentials/store.ts';
import { Approvals } from './proxy/approvals.ts';
import { Audit } from './proxy/audit.ts';
import { CertificateAuthority, writeBundle } from './proxy/ca.ts';
import { HostProxy } from './proxy/proxy.ts';
import { checkSettings, loadSettings, saveSettings } from './proxy/settings.ts';
import { Vault } from './vault/store.ts';

/**
 * The host placement's services, one process the daemon starts and stops:
 *
 *   node main.ts --root <~/.anchi/host> [--version <anchi version>]
 *
 * Layout under the root: state/auth (the vault), state/ca (the proxy's CA), state/run
 * (control.sock, control.token), state/egress/settings.json, audit.jsonl and ca-bundle.pem.
 * The vault key and the credentials exist in this process only.
 */

export class HostServices {
  readonly paths: HostServicesPaths;
  readonly vault: Vault;
  readonly credentials: CredentialStore;
  readonly approvals: Approvals;
  readonly audit: Audit;
  readonly ca: CertificateAuthority;
  readonly proxy: HostProxy;
  readonly control: ControlServer;
  private settings;

  constructor(
    root: string,
    private readonly version: string,
    private readonly log: (line: string) => void = (line) => console.error(line),
    openssl = 'openssl',
  ) {
    this.paths = hostServicesPaths(root);
    for (const dir of [this.paths.state, this.paths.auth, this.paths.ca, this.paths.run]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.vault = new Vault(this.paths.auth);
    this.credentials = new CredentialStore(this.vault);
    this.settings = loadSettings(this.paths.settings);
    this.approvals = new Approvals(this.settings.approval_timeout_s);
    this.audit = new Audit(this.paths.audit);
    this.ca = new CertificateAuthority(this.paths.ca, openssl);
    this.proxy = new HostProxy({
      ca: this.ca,
      audit: this.audit,
      approvals: this.approvals,
      credentials: this.credentials,
      settings: () => this.settings,
      log: this.log,
    });
    this.control = new ControlServer(
      this.paths.control,
      this.paths.token,
      {
        version: () => ({ runtime_version: this.version, installed_at: null }),
        list: () => ({ cells: [] }),
        quota: () => ({}),
        register: (r) => this.proxy.register(r as Extract<ControlRequest, { op: 'register' }>),
        unregister: () => this.proxy.unregister(),
        'settings.set': (r) => {
          const request = r as Extract<ControlRequest, { op: 'settings.set' }>;
          let settings;
          try {
            settings = checkSettings(request.settings);
          } catch {
            throw new ControlError('BAD_SETTINGS');
          }
          saveSettings(this.paths.settings, settings);
          this.settings = settings;
          this.approvals.timeout = settings.approval_timeout_s;
          return settings;
        },
        'approvals.decide': (r) => {
          const request = r as Extract<ControlRequest, { op: 'approvals.decide' }>;
          return this.approvals.decide(request.id, request.allow);
        },
        verify: (r) =>
          this.proxy.verify((r as Extract<ControlRequest, { op: 'verify' }>).connector),
        'vault.status': () => ({ ...this.vault.status(), legacy_files: 0 }),
        'vault.unlock': (r) => {
          const request = r as Extract<ControlRequest, { op: 'vault.unlock' }>;
          try {
            this.vault.unlock(request.key);
          } catch (err) {
            throw new ControlError((err as { code?: string }).code ?? 'VAULT_ADMIN_FAILED');
          }
          return { unlocked: true, migrated: [] };
        },
        'vault.lock': () => {
          this.vault.lock();
          return { unlocked: false };
        },
        'credentials.status': () => this.credentials.status(),
        'credentials.import': (r) => {
          const request = r as Extract<ControlRequest, { op: 'credentials.import' }>;
          return this.guarded(() => this.credentials.importToken(request.connector, request.value));
        },
        'credentials.importAws': (r) => {
          const {
            op: _op,
            token: _token,
            ...value
          } = r as Extract<ControlRequest, { op: 'credentials.importAws' }>;
          return this.guarded(() => this.credentials.importAws(value));
        },
        'credentials.remove': (r) =>
          this.guarded(() =>
            this.credentials.remove(
              (r as Extract<ControlRequest, { op: 'credentials.remove' }>).connector,
            ),
          ),
        'credentials.setAccount': (r) => {
          const request = r as Extract<ControlRequest, { op: 'credentials.setAccount' }>;
          return this.guarded(() => this.credentials.setAccount(request.connector, request.label));
        },
      },
      (write, onClose) => onClose(this.approvals.watch(write)),
    );
  }

  /** Vault errors reach the daemon as their codes, nothing else does. */
  private guarded<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ControlError) throw err;
      throw new ControlError((err as { code?: string }).code ?? 'CREDENTIAL_ERROR');
    }
  }

  async start(): Promise<void> {
    await this.ca.ensure();
    writeBundle(this.ca, this.paths.bundle);
    await this.control.start();
    this.audit.row({ event: 'start' });
    this.log(`host services ${this.version}: control socket ${this.paths.control}`);
  }

  async stop(): Promise<void> {
    await this.proxy.stop();
    await this.control.stop();
    this.vault.lock();
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export { type HostServicesPaths, hostServicesPaths };

// Run as the process entry (the source file or the release bundle), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = argument('--root');
  if (!root) {
    console.error('usage: main.ts --root <~/.anchi/host> [--version <version>] [--parent <pid>]');
    process.exit(2);
  }
  let version = argument('--version') ?? 'unknown';
  if (version === 'unknown') {
    try {
      version = (
        JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
          version: string;
        }
      ).version;
    } catch {
      // A bundle without the workspace manifest keeps 'unknown'.
    }
  }
  const services = new HostServices(root, version);
  const stop = () => void services.stop().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // Started by the daemon: end with it, so a daemon that crashed leaves no orphan on the port.
  const parent = Number(argument('--parent'));
  if (parent > 0) {
    const watch = setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        stop();
      }
    }, 5_000);
    watch.unref();
  }
  services.start().catch((err: Error) => {
    console.error(`host services failed to start: ${err.message}`);
    process.exit(1);
  });
}
