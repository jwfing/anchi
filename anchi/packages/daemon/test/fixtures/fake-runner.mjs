// Stands in for `anchi-cell start`: speaks the runner protocol on stdio.
// FAKE_MODE: ok | bad-frame | wrong-turn | huge | slow | fail-start
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MODE ?? 'ok';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
if (mode === 'fail-start') {
  send({ error: 'BASE_IMAGE_NOT_BUILT' });
  process.exit(1);
}
send({ type: 'ready', protocol: 2, runtime: 'codex', version: 'fake 1' });
let turns = 0;
const rl = createInterface({ input: process.stdin });
// Tool calls waiting for the daemon: input "call <tool> <json args>" makes one.
const waiting = new Map();
rl.on('line', (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === 'tool.response') {
    const turn = waiting.get(cmd.id);
    waiting.delete(cmd.id);
    send({ type: 'event', turn, event: { type: 'message', text: JSON.stringify(cmd) } });
    send({ type: 'turn.end', turn, ok: true });
    return;
  }
  if (cmd.type === 'cancel') {
    send({
      type: 'event',
      turn: cmd.turn,
      event: { type: 'error', message: 'interrupted', fatal: true },
    });
    send({ type: 'turn.end', turn: cmd.turn, ok: false });
    return;
  }
  turns++;
  // "write <path>": the agent changes a file (workspace audit tests).
  const written = /^write (\S+)$/.exec(cmd.input ?? '');
  if (written) writeFileSync(written[1], '#!/bin/sh\necho planted\n');
  const tool = /^call (\S+)(?: (.*))?$/.exec(cmd.input ?? '');
  if (tool) {
    waiting.set(`c${turns}`, cmd.turn);
    send({
      type: 'tool.request',
      turn: cmd.turn,
      id: `c${turns}`,
      tool: tool[1],
      args: tool[2] ? JSON.parse(tool[2]) : {},
    });
    return;
  }
  if (mode === 'bad-frame') return process.stdout.write('not json\n');
  if (mode === 'wrong-turn') return send({ type: 'turn.end', turn: 'other', ok: true });
  if (mode === 'huge') return process.stdout.write('x'.repeat(300 * 1024));
  if (mode === 'slow') return;
  if (!cmd.resumeId)
    send({
      type: 'event',
      turn: cmd.turn,
      event: { type: 'session.started', resumeId: 'thread-1' },
    });
  send({
    type: 'event',
    turn: cmd.turn,
    event: { type: 'tool.call', id: 'c1', name: 'shell', input: '{"command":"ls"}' },
  });
  send({
    type: 'event',
    turn: cmd.turn,
    event: { type: 'tool.result', id: 'c1', output: 'README.md', isError: false },
  });
  send({
    type: 'event',
    turn: cmd.turn,
    event: {
      type: 'message',
      text: `turn ${turns} pid ${process.pid} resume=${cmd.resumeId ?? '-'}: ${cmd.input} https://github.com/o/r/pull/1`,
    },
  });
  send({ type: 'event', turn: cmd.turn, event: { type: 'turn.completed' } });
  send({ type: 'turn.end', turn: cmd.turn, ok: true });
});
rl.on('close', () => process.exit(0));
