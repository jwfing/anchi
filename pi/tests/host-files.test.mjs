import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serve } from '../protocol.mjs';
import { hostFileRequest } from '../host-files.mjs';

test('host file replies resolve during an active RPC turn without model or credentials', async () => {
  const input = new PassThrough();
  let observed;
  const running = serve({
    input,
    listSessions: async () => [],
    createSession: async ({notify}) => ({
      model:'fixture',resetBudget(){},session:{sessionId:'fixture',messages:[],subscribe(){return()=>{};},dispose(){},async abort(){},async prompt(){observed=await hostFileRequest({op:'grants'},notify);}}
    }),
    notify(value) {
      if(value.type==='ready') input.write(JSON.stringify({id:'turn1',op:'prompt',text:'synthetic'})+'\n');
      if(value.type==='host_file_request') input.write(JSON.stringify({op:'host_file_result',id:value.id,ok:true,result:{grants:[]}})+'\n');
      if(value.type==='finished') input.end();
    }
  });
  await running;
  assert.deepEqual(observed,{grants:[]});
});
