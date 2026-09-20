import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sessionPath } from '../sessions.mjs';

test('resume accepts an existing session but rejects traversal, symlinks and mismatched headers',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-sessions-'));
  const id='12345678-1234-1234-1234-123456789012';
  const file=path.join(dir,`time_${id}.jsonl`);
  try {
    const header={type:'session',id,cwd:'/workspace'};
    await fs.writeFile(file,JSON.stringify(header)+'\n');
    assert.equal(await sessionPath(id,dir),file);
    await assert.rejects(sessionPath('../auth.json',dir),/INVALID_SESSION_ID/);
    await fs.writeFile(file,JSON.stringify({...header,id:'wrong'})+'\n');
    await assert.rejects(sessionPath(id,dir),/INVALID_SESSION_FILE/);
    await fs.unlink(file);
    await fs.symlink('/etc/passwd',file);
    await assert.rejects(sessionPath(id,dir),/INVALID_SESSION_FILE/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
