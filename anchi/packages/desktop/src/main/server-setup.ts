import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sanitizeLine } from '@anchi/core';
import {
  parseServer,
  type ProbeResult,
  type RemoteTarget,
  type SavedServer,
} from '@anchi/daemon/client';
import type { Confirmation } from './bridge.ts';

/** Initialization is a host action: it must work before the remote daemon exists. */
export class ServerSetup {
  private running = new Set<string>();

  constructor(
    private opts: {
      servers(): SavedServer[];
      pin(target: string): () => void;
      probe(target: RemoteTarget): Promise<ProbeResult>;
      confirm(question: Confirmation): Promise<boolean>;
      install(target: RemoteTarget): Promise<void>;
      connect(target: string): Promise<void>;
    },
  ) {}

  busy(target: string) {
    return this.running.has(target);
  }

  async initialize(input: unknown): Promise<boolean> {
    const saved =
      typeof input === 'string'
        ? this.opts.servers().find((s) => s.target === input && s.target !== 'local')
        : undefined;
    if (!saved) throw new Error('choose a saved remote machine');
    const target = parseServer(saved.target);
    if (target.kind !== 'remote') throw new Error('choose a saved remote machine');
    if (this.running.has(saved.target)) throw new Error('initialization is already running');
    this.running.add(saved.target);
    try {
      const probe = await this.opts.probe(target);
      if (probe.kind === 'ok') {
        await this.opts.connect(saved.target);
        return true;
      }
      if (probe.kind !== 'bridge-missing') throw new Error(probe.detail);
      const current = this.opts.pin(saved.target);
      if (
        !(await this.opts.confirm({
          message: `Initialize Anchi on ${saved.name}?`,
          detail: `Machine: ${saved.name} (${saved.target})\n\nDownload this app's matching Anchi release, install its bridge and enable the daemon at boot using passwordless sudo. Instabox agent data uses /data/anchi. Then continue with environment setup on this machine. Credentials stay on their machines.`,
          button: 'Initialize',
        }))
      )
        return false;
      current();
      if (!this.opts.servers().some((s) => s.name === saved.name && s.target === saved.target)) {
        throw new Error('machine changed; review initialization again');
      }
      await this.opts.install(target);
      const result = await this.opts.probe(target);
      if (result.kind !== 'ok') throw new Error(`Initialization did not finish: ${result.detail}`);
      await this.opts.connect(saved.target);
      return true;
    } finally {
      this.running.delete(saved.target);
    }
  }
}

const FILES = ['bootstrap-server.sh', 'install.sh', 'anchi-bridge.py', 'anchi_data_dir.py'];

/** Only bundled public setup resources cross SSH; no checkout or host login files are sent. */
export async function bootstrapServer(target: RemoteTarget, assets: string): Promise<void> {
  const version = (await readFile(join(assets, 'version'), 'utf8')).trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('invalid bundled Anchi version');
  }
  const [command, ...args] = target.ssh;
  if (!command) throw new Error('missing SSH command');
  const directory = target.name.startsWith('instabox:') ? '/data/anchi' : '/var/lib/anchi';
  const script = `set -eu
bootstrap_dir=$(mktemp -d)
trap 'rm -rf "$bootstrap_dir"' EXIT
tar xzf - -C "$bootstrap_dir"
bash "$bootstrap_dir/bootstrap-server.sh" ${version} ${directory}`;
  const remote = spawn(command, [...args, script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 600_000,
  });
  const archive = spawn('tar', ['-czf', '-', '-C', assets, ...FILES], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    timeout: 30_000,
  });
  let output = '';
  const collect = (data: Buffer) => {
    output = (output + data.toString('utf8')).slice(-8000);
  };
  remote.stdout.on('data', collect);
  remote.stderr.on('data', collect);
  archive.stderr.on('data', collect);
  const exited = (child: ChildProcess, label: string) =>
    new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`${label} failed (${signal ?? code}): ${sanitizeLine(output).slice(-4000)}`),
          );
      });
    });
  try {
    await Promise.all([
      exited(remote, 'Remote initialization'),
      exited(archive, 'Bundling setup resources'),
      pipeline(archive.stdout, remote.stdin),
    ]);
  } catch (err) {
    remote.kill();
    archive.kill();
    throw err;
  }
}
