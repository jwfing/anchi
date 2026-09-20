import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Controller, serve } from '../protocol.mjs';

function fixture() {
  const events=[],saved=new Map(); let seq=0;
  const createSession=async({sessionId,notify})=>{
    if (sessionId && !saved.has(sessionId)) throw new Error('SESSION_NOT_FOUND');
    const id=sessionId || `session-${++seq}`;
    const messages=saved.get(id)||[];saved.set(id,messages);
    let listener,resolve;
    const session={sessionId:id,sessionFile:`/${id}`,messages,
      subscribe(fn){listener=fn;return()=>{};},dispose(){},
      async prompt(text){messages.push({role:'user',content:text});notify({type:'approval_required',approval_id:'approval'});
        await new Promise(r=>resolve=r);
      },
      async abort(){listener({type:'message_end',message:{role:'assistant',content:[],stopReason:'aborted'}});resolve?.();},
      finish(text='OK'){messages.push({role:'assistant',content:[{type:'text',text}]});resolve?.();}
    };
    return {session,model:'test',resetBudget(){this.resets=(this.resets||0)+1;}};
  };
  const controller=new Controller({createSession,listSessions:async()=>[...saved.keys()],notify:e=>events.push(e)});
  return {controller,events,createSession};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('prompt stays cancellable; busy rejects another prompt; budget resets per user turn',async()=>{
  const {controller:c,events}=fixture();await c.start();
  await c.handle({id:'p1',op:'prompt',text:'hello'});await tick();
  assert.equal(events.find(e=>e.type==='approval_required').turn_id,'p1');
  await c.handle({id:'p2',op:'prompt',text:'second'});
  assert.equal(events.at(-1).error,'BUSY');
  await c.handle({id:'s',op:'status'});assert.equal(events.at(-1).result.busy,true);
  await c.handle({id:'cancel',op:'cancel'});
  assert.equal(c.active,null);assert.equal(events.find(e=>e.type==='finished').cancelled,true);
  await c.handle({id:'p3',op:'prompt',text:'again'});await tick();c.current.session.finish();await c.active.done;
  assert.equal(c.current.resets,2);assert.equal(events.filter(e=>e.type==='finished').at(-1).success,true);
  await c.close();
});
test('history restored without executing anything; invalid resume keeps old session',async()=>{
  const {controller:c,events}=fixture();await c.start();const first=c.info().session_id;
  await c.handle({id:'p',op:'prompt',text:'remember'});await tick();c.current.session.finish('remembered');await c.active.done;
  await c.handle({id:'n',op:'new'});assert.notEqual(c.info().session_id,first);
  await c.handle({id:'r',op:'resume',session_id:first});assert.equal(c.current.session.messages.length,2);assert.equal(c.active,null);
  await c.handle({id:'r2',op:'resume',session_id:'missing'});assert.equal(c.info().session_id,first);assert.equal(events.at(-1).error,'SESSION_NOT_FOUND');
  await c.handle({id:'h',op:'history'});assert.equal(events.at(-1).result.messages[0].text,'remember');await c.close();
});
test('duplicate ids, unknown fields and approval commands rejected',async()=>{
  const {controller:c,events}=fixture();await c.start();
  await c.handle({id:'s',op:'status'});await c.handle({id:'s',op:'prompt',text:'must not run'});assert.equal(events.at(-1).error,'DUPLICATE_COMMAND_ID');
  await c.handle({id:'a',op:'approve'});assert.equal(events.at(-1).error,'UNKNOWN_OPERATION');
  await c.handle({id:'b',op:'prompt',text:'x',approved:true});assert.equal(events.at(-1).error,'BAD_REQUEST');await c.close();
});
test('EOF cancels pending work; oversized line discarded and next command usable',async()=>{
  const {createSession}=fixture();const input=new PassThrough(),events=[];
  const running=serve({input,createSession,listSessions:async()=>[],notify:e=>events.push(e)});
  await tick();input.write('x'.repeat(65537)+'\n');input.write('{bad}\n');
  input.write(JSON.stringify({id:'p',op:'prompt',text:'waiting'})+'\n');await tick();await tick();
  input.end();await running;
  assert(events.some(e=>e.error==='LINE_TOO_LARGE'));assert(events.some(e=>e.error==='INVALID_JSON'));
  assert(events.some(e=>e.type==='finished' && e.cancelled));
});
