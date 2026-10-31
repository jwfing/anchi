import type { ReleaseUpdate } from '../shared.ts';

export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LATEST = 'https://api.github.com/repos/jwfing/anchi/releases/latest';
const MAX_RELEASE_BYTES = 1024 * 1024;

function versionParts(version: string): number[] | undefined {
  if (version.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    return undefined;
  const parts = version.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

/** The version of a stable release document, or null for a draft, prerelease or odd tag. */
export function stableVersion(release: unknown): string | null {
  if (
    typeof release !== 'object' ||
    release === null ||
    !('draft' in release) ||
    release.draft !== false ||
    !('prerelease' in release) ||
    release.prerelease !== false ||
    !('tag_name' in release) ||
    typeof release.tag_name !== 'string' ||
    !release.tag_name.startsWith('v')
  )
    return null;
  const version = release.tag_name.slice(1);
  return versionParts(version) ? version : null;
}

/** -1, 0 or 1; undefined when either is not a plain x.y.z version. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return undefined;
  const difference = left.findIndex((part, i) => part !== right[i]);
  return difference === -1 ? 0 : left[difference]! > right[difference]! ? 1 : -1;
}

/** Only a newer stable tag can produce a notice; release-provided links are never used. */
export function releaseUpdate(currentVersion: string, release: unknown): ReleaseUpdate | null {
  const version = stableVersion(release);
  if (!version || compareVersions(version, currentVersion) !== 1) return null;
  return {
    currentVersion,
    version,
    url: `https://github.com/jwfing/anchi/releases/tag/v${version}`,
  };
}

async function fetchRelease(currentVersion: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(LATEST, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Anchi-Desktop/${currentVersion}`,
    },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!response.ok || !response.body) throw new Error('release check failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RELEASE_BYTES) throw new Error('release response too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
  }
}

/** Desktop-only polling: no daemon, account or agent data participates in this request. */
export class ReleaseUpdates {
  available: ReleaseUpdate | null = null;
  /** The latest stable release, newer than this app or not; a machine can be older than both. */
  latest: string | null = null;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;

  constructor(
    private opts: {
      currentVersion: string;
      changed(update: ReleaseUpdate | null): void;
      fetcher?: typeof fetch;
    },
  ) {}

  check(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const release = await fetchRelease(this.opts.currentVersion, this.opts.fetcher ?? fetch);
        this.latest = stableVersion(release);
        this.available = releaseUpdate(this.opts.currentVersion, release);
        this.opts.changed(this.available);
      } catch {
        // Offline, rate limited or malformed: keep working and retry at the next interval.
      }
    })().finally(() => (this.pending = undefined));
    return this.pending;
  }

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), UPDATE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
