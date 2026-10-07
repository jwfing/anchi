#!/usr/bin/env -S node --import tsx
import { createInterface } from 'node:readline';
import { styleText } from 'node:util';
import { homeLayout } from '@anchi/core';
import {
  connectOrStart,
  type DaemonClient,
  installLaunchd,
  tryConnect,
  uninstallLaunchd,
} from '@anchi/daemon';
import type { ConnectorId, ConnectorSecret, SetupAction, TaskRow } from '@anchi/protocol';
import { Command } from 'commander';
import { TerminalRenderer } from './render.ts';
import { sanitizeLine } from './sanitize.ts';
import { runTui } from './tui/index.tsx';

const layout = homeLayout();

function fail(message: string): never {
  console.error(styleText('red', sanitizeLine(message)));
  process.exit(1);
}

async function withClient<T>(fn: (c: DaemonClient) => Promise<T>): Promise<T> {
  const client = await connectOrStart(layout);
  try {
    return await fn(client);
  } catch (err) {
    fail((err as Error).message);
  } finally {
    client.close();
  }
}

/** Reads a line from the terminal without echoing it. */
function askSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    process.stdout.write(prompt);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes('\n')) write.call(rl, '\n');
    };
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function taskLine(t: TaskRow): string {
  const color = {
    queued: 'blue',
    running: 'yellow',
    done: 'green',
    failed: 'red',
    cancelled: 'gray',
  } as const;
  return `${styleText(color[t.status], t.status.padEnd(10))}${t.id}  @${t.agentId.padEnd(12)} ${sanitizeLine(t.title).slice(0, 60)}${
    t.links.length ? `  ${t.links.map(sanitizeLine).join(' ')}` : ''
  }`;
}

/** Streams a task's events until its current turn ends. */
async function follow(client: DaemonClient, task: TaskRow, verbose: boolean): Promise<TaskRow> {
  const renderer = new TerminalRenderer(process.stdout, verbose);
  let last = 0;
  const off = client.on('event', ({ taskId, seq, event }) => {
    if (taskId !== task.id || seq === undefined || seq <= last) return;
    last = seq;
    renderer.render(event);
  });
  for (const e of await client.call('tasks.events', { taskId: task.id })) {
    if (e.seq > last) {
      last = e.seq;
      renderer.render(e.event);
    }
  }
  const done = await client.call('tasks.wait', { taskId: task.id });
  off();
  return done;
}

const program = new Command('anchi').description('安栖 Anchi: a secure, controllable agent team');

program
  .command('tui', { isDefault: true })
  .description('Open the full-screen client (starts the daemon if needed)')
  .action(async () => {
    const client = await connectOrStart(layout).catch((e: Error) => fail(e.message));
    await runTui(client);
  });

program
  .command('run <agent> <text...>')
  .description('Give an agent a task and stream it until the turn ends')
  .option('-v, --verbose', 'show tool output')
  .action((agentId: string, words: string[], opts: { verbose?: boolean }) =>
    withClient(async (client) => {
      const task = await client.call('tasks.create', { agentId, text: words.join(' ') });
      const done = await follow(client, task, Boolean(opts.verbose));
      console.log(taskLine(done));
      if (done.status !== 'done') process.exitCode = 1;
    }),
  );

program
  .command('send <task> <text...>')
  .description('Send a follow-up to a task')
  .option('-v, --verbose', 'show tool output')
  .action((taskId: string, words: string[], opts: { verbose?: boolean }) =>
    withClient(async (client) => {
      const task = await client.call('tasks.send', { taskId, text: words.join(' ') });
      const done = await follow(client, task, Boolean(opts.verbose));
      console.log(taskLine(done));
      if (done.status !== 'done') process.exitCode = 1;
    }),
  );

program
  .command('tasks')
  .description('List recent tasks')
  .option('-a, --agent <id>')
  .action((opts: { agent?: string }) =>
    withClient(async (client) => {
      for (const t of await client.call('tasks.list', { agentId: opts.agent, limit: 50 }))
        console.log(taskLine(t));
    }),
  );

program
  .command('scan <task>')
  .description("Credential-invariant scan of a task's live cell")
  .action(async (taskId: string) => {
    await withClient(async (client) => {
      const r = await client.call('tasks.scan', { taskId });
      console.log(
        r.clean
          ? styleText(
              'green',
              `clean: no real credential in ${r.files} files or the cell's processes`,
            )
          : styleText('red', `FOUND: ${JSON.stringify(r.findings)}`),
      );
      if (!r.clean) process.exitCode = 1;
    });
  });

program.command('cancel <task>').action(async (taskId: string) => {
  await withClient((client) => client.call('tasks.cancel', { taskId }));
});

program
  .command('agents')
  .description('List agents')
  .action(() =>
    withClient(async (client) => {
      for (const a of await client.call('agents.list')) {
        const extra = a.error
          ? styleText('red', ` ${sanitizeLine(a.error)}`)
          : ` ${a.connectors.join(',') || '-'} · ${a.image}`;
        console.log(`${a.id.padEnd(14)} ${a.status.padEnd(8)}${extra}`);
      }
    }),
  );

const setup = program.command('setup').description('Runtime and connector setup');

setup.command('status').action(() =>
  withClient(async (client) => {
    console.log(JSON.stringify(await client.call('setup.status'), null, 2));
  }),
);

setup
  .command('codex')
  .description('Import the Codex login from ~/.codex/auth.json into the VM vault')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((opts: { yes?: boolean }) =>
    withClient(async (client) => {
      if (!opts.yes) {
        const answer = await ask(
          'Read the access token and account id from ~/.codex/auth.json and store them in the VM vault? [y/N] ',
        );
        if (answer.toLowerCase() !== 'y') fail('cancelled');
      }
      const s = await client.call('setup.importCodex');
      console.log(
        `Codex connected; token valid until ${new Date(s.expiresAt ?? 0).toLocaleString()}`,
      );
    }),
  );

/** Runs a setup step in the daemon and prints its output as it arrives. */
function runSetup(action: SetupAction, yes: boolean, consent: string) {
  return withClient(async (client) => {
    if (!yes && (await ask(`${consent} [y/N] `)).toLowerCase() !== 'y') fail('cancelled');
    const off = client.on('setup', (n) => {
      if (n.action === action) console.log(sanitizeLine(n.line));
    });
    const s = await client.call('setup.run', { action });
    off();
    console.log(
      `VM ${s.vm} · vault ${s.vaultUnlocked ? 'unlocked' : 'locked'} · base image ${s.installed ? 'built' : 'not built'}`,
    );
  });
}

setup
  .command('claude')
  .description('Store a `claude setup-token` token or an Anthropic API key in the VM vault')
  .action(() =>
    withClient(async (client) => {
      const token = process.stdin.isTTY
        ? await askSecret('Claude Code token (from `claude setup-token`) or API key: ')
        : await readStdin();
      const s = await client.call('setup.importClaude', { token });
      console.log(
        `Claude Code connected (${s.kind === 'api_key' ? 'API key' : 'subscription token'})`,
      );
    }),
  );

setup
  .command('vm')
  .description('Start the VM')
  .action(() => runSetup('vm-start', true, ''));

setup
  .command('install')
  .description('Create or update the VM, install the services and build the base image')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((opts: { yes?: boolean }) =>
    runSetup(
      'install',
      Boolean(opts.yes),
      'Create or update the secure-vm VM, install the trusted services and the agent team, and build the base image (several minutes)?',
    ),
  );

setup
  .command('vault <action>')
  .description('init or unlock the VM vault with the key in ~/.config/secure-vm/vault.key')
  .action((action: string) => {
    if (action !== 'init' && action !== 'unlock') fail('vault action must be init or unlock');
    return runSetup(action === 'init' ? 'vault-init' : 'vault-unlock', true, '');
  });

setup
  .command('connector <id>')
  .description('Connect github, aws or linear (secrets are read without echo)')
  .option('--from-gh', 'github: import the token the gh CLI is logged in with')
  .option('--profile <name>', 'aws: use a host profile (SSO); the daemon keeps it refreshed')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((id: string, opts: { fromGh?: boolean; profile?: string; yes?: boolean }) =>
    withClient(async (client) => {
      if (opts.fromGh) {
        if (id !== 'github') fail('--from-gh applies to github');
        const consent =
          'Read the token of the gh CLI (`gh auth token`) and store it in the VM vault? ' +
          'It carries all the scopes of your gh login; a fine-grained token is narrower.';
        if (!opts.yes && (await ask(`${consent} [y/N] `)).toLowerCase() !== 'y') fail('cancelled');
        const status = await client.call('connectors.importGh');
        return console.log(`github connected (${sanitizeLine(status.account ?? '?')})`);
      }
      if (opts.profile) {
        if (id !== 'aws') fail('--profile applies to aws');
        const status = await client.call('connectors.awsProfile', { profile: opts.profile });
        return console.log(
          `aws connected (${sanitizeLine(status.account ?? '?')}) through profile ${sanitizeLine(opts.profile)}; refreshed before expiry`,
        );
      }
      let secret: ConnectorSecret;
      if (id === 'github' || id === 'linear') {
        // Tokens may also come on stdin for scripts: `anchi setup connector github < token-file`.
        const token = process.stdin.isTTY ? await askSecret(`${id} token: `) : await readStdin();
        secret = { id, token };
      } else if (id === 'aws' && !process.stdin.isTTY) {
        // Scripts: {"accessKeyId", "secretAccessKey", "region", "sessionToken"?} on stdin.
        const v = JSON.parse(await readStdin()) as Record<string, string>;
        secret = {
          id: 'aws',
          accessKeyId: v.accessKeyId ?? '',
          secretAccessKey: v.secretAccessKey ?? '',
          region: v.region ?? '',
          ...(v.sessionToken ? { sessionToken: v.sessionToken } : {}),
        };
      } else if (id === 'aws') {
        secret = {
          id: 'aws',
          accessKeyId: await ask('Access key id (dedicated principal): '),
          secretAccessKey: await askSecret('Secret access key: '),
          region: await ask('Region: '),
        };
        const session = await askSecret('Session token (Enter to skip): ');
        if (session) secret.sessionToken = session;
      } else {
        fail('connector must be github, aws or linear');
      }
      const status = await client.call('connectors.set', secret);
      console.log(
        `${status.id} connected${status.account ? ` (${sanitizeLine(status.account)})` : ''}`,
      );
    }),
  );

setup.command('disconnect <id>').action(async (id: string) => {
  await withClient((client) => client.call('connectors.remove', { id: id as ConnectorId }));
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) fail('no secret on stdin: run this in a terminal to be prompted, or redirect a file');
  return text;
}

const daemon = program.command('daemon').description('Manage the background daemon');
daemon.command('start').action(async () => {
  (await connectOrStart(layout)).close();
  console.log('daemon running');
});
daemon.command('stop').action(async () => {
  const client = await tryConnect(layout);
  if (!client) return console.log('daemon not running');
  await client.call('daemon.shutdown');
  client.close();
  console.log('daemon stopped');
});
daemon.command('status').action(async () => {
  const client = await tryConnect(layout);
  if (!client) return console.log('daemon not running');
  console.log(JSON.stringify(await client.call('daemon.status'), null, 2));
  client.close();
});
daemon
  .command('install')
  .description('Run the daemon at login (launchd)')
  .action(() => console.log(`installed ${installLaunchd(layout)}`));
daemon
  .command('uninstall')
  .action(() => console.log(uninstallLaunchd() ? 'uninstalled' : 'not installed'));

await program.parseAsync();
