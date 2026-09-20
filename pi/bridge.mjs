import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from '@earendil-works/pi-ai/api/openai-responses-shared';

export function rpc(path, request, signal) {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = net.createConnection({ path });
    const stop = () => socket.destroy(new Error('ABORTED'));
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    socket.setTimeout(150000, () => socket.destroy(new Error('GATEWAY_TIMEOUT')));
    socket.on('connect', () => {
      // Match Python's ensure_ascii encoding so the byte limit is consistent.
      const wire = JSON.stringify(request).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';
      if (Buffer.byteLength(wire) > 65536) return socket.destroy(new Error('REQUEST_TOO_LARGE'));
      socket.write(wire);
    });
    socket.on('data', chunk => {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 65536) return socket.destroy(new Error('RESPONSE_TOO_LARGE'));
      if (data.includes('\n')) {
        socket.end();
        try {
          const value = JSON.parse(data);
          if (!value.ok) reject(new Error(value.error));
          else resolve(value.result);
        } catch { reject(new Error('BAD_GATEWAY_RESPONSE')); }
      }
    });
    socket.on('error', () => reject(new Error('GATEWAY_UNAVAILABLE')));
    socket.on('close', () => {
      signal?.removeEventListener('abort', stop);
      if (!data.includes('\n')) reject(new Error('GATEWAY_DISCONNECTED'));
    });
  });
}

export function createBridge({ maxCalls = 8, notify = () => {} } = {}) {
  let calls = 0;
  const bridge = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const output = { role:'assistant', content:[], api:model.api, provider:model.provider, model:model.id,
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      stopReason:'pending', timestamp:Date.now() };
    (async () => {
      try {
        if (++calls > maxCalls) throw new Error('PI_TURN_LIMIT');
        const request = {op:'pi_generate',request_id:randomUUID().replaceAll('-',''),
          instructions:context.systemPrompt || 'You are a helpful assistant.',
          input:convertResponsesMessages(model,context,new Set(['secure-codex']),{includeSystemPrompt:false}),
          tools:convertResponsesTools(context.tools || [], {strict:null,supportsOpenAIGrammarTools:false})};
        let response;
        let notified = '';
        const deadline = Date.now() + 600000;
        while (true) {
          try { response = await rpc('/run/secure-inference/api.sock',request,options?.signal); break; }
          catch (error) {
            if (!error.message.startsWith('APPROVAL_REQUIRED:')) throw error;
            if (Date.now() > deadline) throw new Error('APPROVAL_WAIT_TIMEOUT');
            const id = error.message.split(':')[1];
            if (id !== notified) { notify({type:'approval_required',approval_id:id,request_id:request.request_id}); notified = id; }
            await delay(3000,undefined,{signal:options?.signal});
          }
        }
        if (options?.signal?.aborted) throw new Error('ABORTED');
        stream.push({type:'start',partial:output});
        // The trusted gateway buffers bounded SSE. Reuse pi's official conversion logic.
        async function* events() {
          for (const [index,item] of (response.output || []).entries()) {
            yield {type:'response.output_item.done',output_index:index,item};
          }
          yield {type:'response.completed',response};
        }
        await processResponsesStream(events(),output,stream,model);
        if (output.stopReason === 'pending' || output.stopReason === 'error') throw new Error('MODEL_RESPONSE_INVALID');
        stream.push({type:'done',reason:output.stopReason,message:output});
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
        output.errorMessage = error.message;
        stream.push({type:'error',reason:output.stopReason,error:output});
        stream.end();
      }
    })();
    return stream;
  };
  bridge.resetBudget = () => { calls = 0; };
  return bridge;
}
