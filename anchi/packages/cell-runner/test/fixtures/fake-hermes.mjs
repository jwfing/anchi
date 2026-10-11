#!/usr/bin/env node
// A stand-in for `hermes acp`, replaying what Hermes 2026.9.24 sent in a recorded session:
// a terminal tool call, its result, the answer, usage. FAKE_HERMES_LOG records requests.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (m) =>
  process.env.FAKE_HERMES_LOG &&
  appendFileSync(process.env.FAKE_HERMES_LOG, JSON.stringify(m) + '\n');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, u) =>
  send({ method: 'session/update', params: { sessionId, update: u } });
let sessions = 0;
let pendingPermission;

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.method === undefined && m.id === 'perm') return pendingPermission?.(m.result);
  switch (m.method) {
    case 'initialize':
      return send({
        id: m.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      });
    case 'session/new':
      return send({ id: m.id, result: { sessionId: `s-${++sessions}` } });
    case 'session/resume': {
      // History is replayed before the answer.
      update(m.params.sessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'old' },
      });
      update(m.params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'old answer' },
      });
      const known = m.params.sessionId === 's-known';
      const id = known ? 's-known' : `s-${++sessions}`;
      return send({
        id: m.id,
        result: { _meta: { hermes: { sessionProvenance: { acpSessionId: id } } } },
      });
    }
    case 'session/set_mode':
      return send({ id: m.id, result: {} });
    case 'session/cancel':
      return;
    case 'session/prompt': {
      const sid = m.params.sessionId;
      const text = m.params.prompt[0].text;
      if (text === 'crash') process.exit(3);
      if (text === 'ask') {
        pendingPermission = (r) => {
          update(sid, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `permission ${r.outcome.optionId}` },
          });
          send({ id: m.id, result: { stopReason: 'end_turn' } });
        };
        return send({
          id: 'perm',
          method: 'session/request_permission',
          params: {
            sessionId: sid,
            toolCall: { toolCallId: 't' },
            options: [
              { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' },
              { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
            ],
          },
        });
      }
      update(sid, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking about ' },
      });
      update(sid, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'echo.' },
      });
      update(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'terminal: echo hello-from-tool',
        kind: 'execute',
        content: [{ type: 'content', content: { type: 'text', text: '$ echo hello-from-tool' } }],
      });
      update(sid, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'terminal result\n- **output:** hello-from-tool' },
          },
        ],
      });
      update(sid, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\n\nDone: ' },
      });
      update(sid, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `${text}.` },
      });
      update(sid, { sessionUpdate: 'usage_update', size: 131072, used: 8864 });
      return send({
        id: m.id,
        result: {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 22,
            outputTokens: 14,
            cachedReadTokens: 3,
            thoughtTokens: 2,
            totalTokens: 36,
          },
        },
      });
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: 'unknown' } });
  }
});
