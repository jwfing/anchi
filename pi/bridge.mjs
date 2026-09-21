import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from '@earendil-works/pi-ai/api/openai-responses-shared';
import { LIMITS } from './limits.mjs';

/** One bounded JSON line per connection over a trusted Unix socket; UTF-8 on the wire. */
export function rpc(path, request, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0,
      settled = false;
    const socket = net.createConnection({ path });
    const stop = () => socket.destroy(new Error('ABORTED'));
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    socket.setTimeout(150000, () => socket.destroy(new Error('GATEWAY_TIMEOUT')));
    socket.on('connect', () => {
      const wire = JSON.stringify(request) + '\n';
      if (Buffer.byteLength(wire) > LIMITS.rpc_bytes)
        return socket.destroy(new Error('REQUEST_TOO_LARGE'));
      socket.write(wire);
    });
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMITS.rpc_bytes) return socket.destroy(new Error('RESPONSE_TOO_LARGE'));
      chunks.push(chunk);
      if (chunk.includes(0x0a)) {
        socket.end();
        settled = true;
        // Decode only once the frame is complete so multi-byte characters never split.
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value.ok) reject(new Error(value.error));
          else resolve(value.result);
        } catch {
          reject(new Error('BAD_GATEWAY_RESPONSE'));
        }
      }
    });
    socket.on('error', (error) =>
      reject(new Error(/^[A-Z_]+$/.test(error.message) ? error.message : 'GATEWAY_UNAVAILABLE')),
    );
    socket.on('close', () => {
      signal?.removeEventListener('abort', stop);
      if (!settled) reject(new Error('GATEWAY_DISCONNECTED'));
    });
  });
}

/**
 * Pi streamSimple provider backed by the trusted inference gateway.
 * `call` and `wait` are injectable for offline tests; production uses the Unix socket RPC.
 */
export function createBridge({
  maxCalls = 8,
  notify = () => {},
  call = rpc,
  wait = delay,
  pollMs = 3000,
  approvalWaitMs = 600000,
} = {}) {
  let calls = 0;
  const bridge = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const output = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'pending',
      timestamp: Date.now(),
    };
    (async () => {
      try {
        if (++calls > maxCalls) throw new Error('PI_TURN_LIMIT');
        const request = {
          op: 'pi_generate',
          request_id: randomUUID().replaceAll('-', ''),
          instructions: context.systemPrompt || 'You are a helpful assistant.',
          input: convertResponsesMessages(model, context, new Set(['secure-codex']), {
            includeSystemPrompt: false,
          }),
          tools: convertResponsesTools(context.tools || [], {
            strict: null,
            supportsOpenAIGrammarTools: false,
          }),
        };
        let response;
        let notified = '';
        const deadline = Date.now() + approvalWaitMs;
        while (true) {
          try {
            response = await call('/run/secure-inference/api.sock', request, options?.signal);
            break;
          } catch (error) {
            if (!error.message.startsWith('APPROVAL_REQUIRED:')) throw error;
            if (Date.now() > deadline) throw new Error('APPROVAL_WAIT_TIMEOUT');
            const id = error.message.split(':')[1];
            if (id !== notified) {
              notify({
                type: 'approval_required',
                approval_id: id,
                request_id: request.request_id,
              });
              notified = id;
            }
            await wait(pollMs, undefined, { signal: options?.signal });
          }
        }
        if (options?.signal?.aborted) throw new Error('ABORTED');
        stream.push({ type: 'start', partial: output });
        // The trusted gateway buffers bounded SSE. Reuse pi's official conversion logic.
        async function* events() {
          for (const [index, item] of (response.output || []).entries()) {
            yield { type: 'response.output_item.done', output_index: index, item };
          }
          yield { type: 'response.completed', response };
        }
        await processResponsesStream(events(), output, stream, model);
        if (output.stopReason === 'pending' || output.stopReason === 'error')
          throw new Error('MODEL_RESPONSE_INVALID');
        stream.push({ type: 'done', reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
        output.errorMessage = error.message;
        stream.push({ type: 'error', reason: output.stopReason, error: output });
        stream.end();
      }
    })();
    return stream;
  };
  bridge.resetBudget = () => {
    calls = 0;
  };
  return bridge;
}
