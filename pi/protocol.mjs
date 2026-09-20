import { receiveHostResult } from './host-files.mjs';
import { StringDecoder } from 'node:string_decoder';

export function publicEvent(event) {
  if (event.type === 'tool_execution_start') return {type:'tool_start',tool:event.toolName};
  if (event.type === 'tool_execution_end') return {type:'tool_end',tool:event.toolName,is_error:event.isError};
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    const message=event.message;
    return {type:'assistant',text:message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'),
      stop_reason:message.stopReason,error:message.errorMessage};
  }
}

export class Controller {
  constructor({createSession,listSessions,notify,timeoutMs=15*60*1000}) {
    Object.assign(this,{createSession,listSessions,notify,timeoutMs});
    this.current=null; this.active=null; this.closed=false; this.seen=new Set();
  }
  info() {
    const session=this.current.session;
    return {session_id:session.sessionId,session_file:session.sessionFile,model:this.current.model,
      busy:!!this.active,turn_id:this.active?.id ?? null};
  }
  emit(event) { this.notify({...event,session_id:this.current?.session.sessionId,turn_id:this.active?.id ?? null}); }
  async replace(sessionId) {
    const next=await this.createSession({sessionId,notify:event=>this.emit(event)});
    if (this.closed) { next.session.dispose(); throw new Error('CONNECTION_CLOSED'); }
    const previous=this.current;
    this.unsubscribe?.();
    this.current=next;
    this.unsubscribe=next.session.subscribe(event=>{
      if (event.type==='message_end' && event.message.role==='assistant' && ['error','aborted'].includes(event.message.stopReason)) {
        if (this.active) this.active.failed=true;
      }
      const message=publicEvent(event);
      if (message) this.emit(message);
    });
    previous?.session.dispose();
  }
  async start() {
    await this.replace();
    this.notify({type:'ready',protocol_version:1,agent:'pi',version:'0.85.1',...this.info()});
  }
  response(id,op,ok,result) { this.notify({type:'response',id,op,ok,...(ok?{result}:{error:result})}); }
  async handle(request) {
    const id=request?.id, op=request?.op;
    try {
      if (!request || typeof request!=='object' || Array.isArray(request) || typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('BAD_REQUEST_ID');
      if (this.seen.has(id)) throw new Error('DUPLICATE_COMMAND_ID');
      if (this.seen.size>=10000) throw new Error('CONNECTION_COMMAND_LIMIT');
      this.seen.add(id);
      const extra=op==='prompt'?['text']:op==='resume'?['session_id']:[];
      if (Object.keys(request).some(k=>!['id','op',...extra].includes(k))) throw new Error('BAD_REQUEST');
      if (this.closed) throw new Error('CONNECTION_CLOSED');
      if (op==='status') return this.response(id,op,true,this.info());
      if (op==='sessions') return this.response(id,op,true,{sessions:await this.listSessions()});
      if (op==='cancel') {
        const turn=this.active;
        if (turn) { turn.cancelled=true; await this.current.session.abort(); await turn.done; }
        return this.response(id,op,true,{cancelled:!!turn,turn_id:turn?.id ?? null});
      }
      if (op==='close') { await this.close(); return this.response(id,op,true,{closed:true}); }
      if (this.active) throw new Error('BUSY');
      if (op==='new' || op==='resume') {
        if (op==='resume' && typeof request.session_id!=='string') throw new Error('INVALID_SESSION_ID');
        await this.replace(op==='resume'?request.session_id:undefined);
        return this.response(id,op,true,this.info());
      }
      if (op==='history') {
        const messages=this.current.session.messages.filter(m=>m.role==='user'||m.role==='assistant').slice(-40).map(m=>({
          role:m.role,text:(typeof m.content==='string'?m.content:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')).slice(0,8000)}));
        return this.response(id,op,true,{messages,...this.info()});
      }
      if (op!=='prompt') throw new Error('UNKNOWN_OPERATION');
      if (typeof request.text!=='string'||!request.text.trim()||request.text.length>8000) throw new Error('BAD_PROMPT');
      const turn={id,failed:false,cancelled:false};
      this.active=turn;
      this.current.resetBudget();
      this.response(id,op,true,{accepted:true,...this.info()});
      // Never block the input loop on model/tool execution: cancel remains reachable.
      turn.done=Promise.resolve().then(async()=>{
        const timeout=setTimeout(()=>{ turn.cancelled=true; void this.current.session.abort(); },this.timeoutMs);
        try { await this.current.session.prompt(request.text); }
        catch { turn.failed=true; this.emit({type:'turn_error',error:'PI_EXECUTION_FAILED'}); }
        finally {
          clearTimeout(timeout);
          this.emit({type:'finished',success:!turn.failed&&!turn.cancelled,cancelled:turn.cancelled});
          if (this.active===turn) this.active=null;
        }
      });
    } catch (error) {
      const code=/^[A-Z_]+$/.test(error.message)?error.message:'COMMAND_FAILED';
      this.response(typeof id==='string'?id:null,op,false,code);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed=true;
    const turn=this.active;
    if (turn) { turn.cancelled=true; await this.current.session.abort(); await turn.done; }
    this.unsubscribe?.(); this.current?.session.dispose();
  }
}

export async function serve({input,notify,...options}) {
  const controller=new Controller({...options,notify});
  await controller.start();
  let buffer='', discarded=false, queue=Promise.resolve();
  let queued=0;
  const decoder=new StringDecoder('utf8');
  const enqueue=line=>{
    if (queued>=32) { notify({type:'protocol_error',error:'COMMAND_QUEUE_FULL'}); return; }
    queued++;
    queue=queue.then(async()=>{
      if (controller.closed) return;
      let value;
      try { value=JSON.parse(line); }
      catch { notify({type:'protocol_error',error:'INVALID_JSON'}); return; }
      if (receiveHostResult(value)) return;
      await controller.handle(value);
      if (controller.closed) input.destroy();
    }).finally(()=>queued--);
  };
  const signal=()=>{ void controller.close(); input.destroy(); };
  process.once('SIGINT',signal); process.once('SIGTERM',signal);
  try {
    for await (const chunk of input) {
      for (const part of decoder.write(chunk).split(/(?<=\n)/)) {
        if (!discarded) buffer+=part;
        if (Buffer.byteLength(buffer)>65536) { buffer=''; discarded=true; notify({type:'protocol_error',error:'LINE_TOO_LARGE'}); }
        if (part.endsWith('\n')) {
          if (!discarded && buffer.trim()) enqueue(buffer);
          buffer=''; discarded=false;
        }
      }
    }
  } catch (error) {
    if (!controller.closed) notify({type:'protocol_error',error:'INPUT_CLOSED'});
  } finally {
    await queue;
    await controller.close();
    process.removeListener('SIGINT',signal); process.removeListener('SIGTERM',signal);
  }
}
