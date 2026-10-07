import { describe, expect, it } from 'vitest';
import {
  type CellMessage,
  cellMessageSchema,
  encodeFrame,
  type RuntimeEvent,
} from '@anchi/protocol';
import { codexOptions, mapCodexEvent } from '../src/codex.ts';
import { startRunner, type RunTurn } from '../src/runner.ts';

function harness(runTurn: RunTurn) {
  const out: CellMessage[] = [];
  let data: (b: Buffer) => void = () => {};
  let end: () => void = () => {};
  const exits: number[] = [];
  startRunner(
    {
      write: (f) => out.push(cellMessageSchema.parse(JSON.parse(f))),
      onData: (cb) => (data = cb),
      onEnd: (cb) => (end = cb),
      exit: (c) => exits.push(c),
      log: () => {},
    },
    runTurn,
    'codex-cli 0.0.0',
  );
  const send = (v: unknown) => data(Buffer.from(encodeFrame(v)));
  return { out, send, end: () => end(), exits };
}

const run = (turn: string, input = 'hi') => ({
  type: 'run',
  turn,
  input,
  options: { workdir: '/tmp/anchi-runner-test' },
});
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('cell runner', () => {
  it('announces itself, streams events and ends turns', async () => {
    const h = harness(async function* (t) {
      yield { type: 'message', text: `echo ${t.input}` } satisfies RuntimeEvent;
    });
    expect(h.out[0]).toMatchObject({ type: 'ready', protocol: 1, runtime: 'codex' });
    h.send(run('t1', 'x'));
    await tick();
    expect(h.out.slice(1)).toEqual([
      { type: 'event', turn: 't1', event: { type: 'message', text: 'echo x' } },
      { type: 'turn.end', turn: 't1', ok: true },
    ]);
  });

  it('cancels the running turn and refuses a second concurrent turn', async () => {
    const h = harness(async function* (t) {
      await new Promise((resolve) => t.signal.addEventListener('abort', resolve));
      throw new Error('aborted');
    });
    h.send(run('t1'));
    await tick();
    h.send(run('t2'));
    await tick();
    expect(h.out.at(-1)).toEqual({ type: 'turn.end', turn: 't2', ok: false });
    h.send({ type: 'cancel', turn: 't1' });
    await tick();
    expect(h.out.at(-2)).toMatchObject({ event: { type: 'error', message: 'interrupted' } });
    expect(h.out.at(-1)).toEqual({ type: 'turn.end', turn: 't1', ok: false });
  });

  it('exits on invalid commands and on end of input', () => {
    const h = harness(async function* () {});
    h.send({ type: 'exec', command: 'sh' });
    expect(h.exits).toEqual([2]);
    const g = harness(async function* () {});
    g.end();
    expect(g.exits).toEqual([0]);
  });
});

describe('codex mapping', () => {
  it('maps the cell sandbox to danger-full-access and the opt-in to workspace-write', () => {
    const base = { workdir: '/home/agent/work', instructionsMode: 'append' as const };
    expect(codexOptions({ ...base, sandbox: 'cell' }, {}).thread.sandboxMode).toBe(
      'danger-full-access',
    );
    const opt = codexOptions(
      { ...base, sandbox: 'codex-workspace-write', instructions: 'be brief' },
      {},
    );
    expect(opt.thread.sandboxMode).toBe('workspace-write');
    expect(opt.codex.config).toEqual({ developer_instructions: 'be brief' });
    expect(opt.codex.codexPathOverride).toBe('/opt/codex/bin/codex');
  });

  it('truncates tool output and stringifies tool input within protocol limits', () => {
    const state = { calls: new Set<string>(), warnings: new Set<string>() };
    const events = [
      ...mapCodexEvent(
        {
          type: 'item.completed',
          item: {
            id: 'c1',
            type: 'command_execution',
            command: 'yes',
            aggregated_output: 'y\n'.repeat(100_000),
            exit_code: 0,
            status: 'completed',
          },
        },
        state,
      ),
    ];
    for (const e of events) {
      expect(cellMessageSchema.safeParse({ type: 'event', turn: 't', event: e }).success).toBe(
        true,
      );
    }
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'tool.result']);
  });
});
