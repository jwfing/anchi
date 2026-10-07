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
import type { ConnectorId, ConnectorSecret, TaskRow } from '@anchi/protocol';
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

setup
  .command('connector <id>')
  .description('Connect github, aws or linear (secrets are read without echo)')
  .action((id: string) =>
    withClient(async (client) => {
      let secret: ConnectorSecret;
      if (id === 'github' || id === 'linear') {
        // Tokens may also come on stdin for scripts: `anchi setup connector github < token-file`.
        const token = process.stdin.isTTY ? await askSecret(`${id} token: `) : await readStdin();
        secret = { id, token };
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
  return Buffer.concat(chunks).toString('utf8').trim();
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
