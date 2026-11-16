import { ControlClient } from './control/client.ts';
import { hostServicesPaths } from './paths.ts';

/**
 * Short commands against the running services, for scripts/vault.mjs and the daemon:
 *
 *   node cli.ts --root <~/.anchi/host> vault status|unlock|lock
 *   node cli.ts --root <~/.anchi/host> approvals watch
 *
 * The vault key arrives on stdin as `{"key": <base64>}` and goes to the services over the
 * control socket, never into an argument or a file. `approvals watch` relays the queue's lines
 * to stdout until the services end it, as `anchi-cell approvals watch` did for the daemon.
 * Prints one JSON line otherwise, as vault_admin.py did.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex === -1 ? undefined : args[rootIndex + 1];
  const rest =
    rootIndex === -1 ? args : [...args.slice(0, rootIndex), ...args.slice(rootIndex + 2)];
  const vault = rest[0] === 'vault' && ['status', 'unlock', 'lock'].includes(rest[1] ?? '');
  const watch = rest[0] === 'approvals' && rest[1] === 'watch' && rest.length === 2;
  if (!root || (!vault && !watch)) {
    console.log(JSON.stringify({ error: 'USAGE' }));
    process.exit(1);
  }
  const paths = hostServicesPaths(root);
  const client = new ControlClient(paths.control, paths.token);
  if (watch) {
    client.watch(
      (line) => console.log(line),
      () => process.exit(0),
    );
    return;
  }
  const action = rest[1]!;
  try {
    if (action === 'unlock') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      if (raw.length > 1024) throw new Error('INPUT_TOO_LARGE');
      const key = (JSON.parse(raw.toString('utf8')) as { key?: unknown }).key;
      if (typeof key !== 'string') throw new Error('VAULT_KEY_INVALID');
      console.log(JSON.stringify(await client.call({ op: 'vault.unlock', key })));
    } else {
      console.log(
        JSON.stringify(
          await client.call({ op: action === 'status' ? 'vault.status' : 'vault.lock' }),
        ),
      );
    }
  } catch (err) {
    const message = (err as Error).message;
    console.log(
      JSON.stringify({ error: /^[A-Z_]+(:|$)/.test(message) ? message : 'VAULT_ADMIN_FAILED' }),
    );
    process.exit(1);
  }
}

void main();
