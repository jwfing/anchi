// Explicit live test. Synthetic files only; no model calls or Gmail reads.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Runtime } = require('../src/main/runtime.cjs');
const { FileBroker } = require('../src/main/file-broker.cjs');
const { Lines } = require('../src/shared/protocol.cjs');
async function main() {
  const root = path.resolve(__dirname, '../..');
  const runtime = new Runtime(root);
  const base = await fs.mkdtemp(path.join(root, 'artifacts/file-verification-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const directories = { directories: [{ id, path: base, mode: 'rw' }] };
  const broker = new FileBroker({ directories, runtime });
  let proc;
  try {
    await broker.activate(id);
    const code = `
      import readline from 'node:readline';
      import {hostFileRequest,receiveHostResult} from '/opt/secure-pi/host-files.mjs';
      const lines=readline.createInterface({input:process.stdin});
      lines.on('line',line=>receiveHostResult(JSON.parse(line)));
      const notify=value=>console.log(JSON.stringify(value));
      const request=value=>hostFileRequest(value,notify);
      try {
        const {grants}=await request({op:'grants'});
        const grant=grants[0].id;
        await request({op:'write',grant,path:'report.txt',text:'synthetic cell round trip'});
        const read=await request({op:'read',grant,path:'report.txt'});
        if(read.text!=='synthetic cell round trip') throw Error('MISMATCH');
        for(const path of ['../escape','.env','.anchi-trash']) {
          let denied=false;try{await request({op:'read',grant,path});}catch{denied=true;}
          if(!denied) throw Error('ESCAPE_ALLOWED');
        }
        const replaced=await request({op:'write',grant,path:'report.txt',text:'second version'});
        if(!replaced.previous) throw Error('NO_PREVIOUS');
        const removed=await request({op:'delete',grant,path:'report.txt'});
        if(!removed.trashed_as) throw Error('NO_TRASH');
        const listing=await request({op:'list',grant});
        if(listing.entries.some(e=>e.name.startsWith('.'))) throw Error('TRASH_VISIBLE');
        await request({op:'write',grant,path:'report.txt',text:'synthetic cell round trip'});
        console.log(JSON.stringify({type:'verified'}));
      } finally {lines.close();process.stdin.destroy();}
    `;
    let verified = false;
    proc = spawn(
      await runtime.lima(),
      [
        'shell',
        'secure-vm',
        '--',
        'sudo',
        '/usr/local/sbin/secure-cell-run',
        '/opt/node/bin/node',
        '--input-type=module',
        '-e',
        code,
      ],
      { env: runtime.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    proc.stderr.resume();
    proc.stdin.on('error', () => {});
    const lines = new Lines(
      (value) => {
        if (value.type === 'verified') verified = true;
        if (value.type === 'host_file_request')
          void broker
            .request(value.request)
            .then(
              (result) => ({ ok: true, result }),
              (error) => ({ ok: false, error: error.message }),
            )
            .then((result) =>
              proc.stdin.write(
                JSON.stringify({ op: 'host_file_result', id: value.id, ...result }) + '\n',
              ),
            );
      },
      () => proc.kill(),
    );
    proc.stdout.on('data', (chunk) => lines.push(chunk));
    const timer = setTimeout(() => proc.kill(), 45000);
    const exit = await new Promise((resolve, reject) => {
      proc.once('close', resolve);
      proc.once('error', reject);
    }).finally(() => clearTimeout(timer));
    assert.equal(exit, 0);
    assert(verified);
    assert.equal(
      await fs.readFile(path.join(base, 'report.txt'), 'utf8'),
      'synthetic cell round trip',
    );
    // Overwritten and deleted versions are recoverable by the user, invisible to the agent.
    const trashed = (await fs.readdir(path.join(base, '.anchi-trash'))).sort();
    assert.equal(trashed.length, 2);
    const contents = await Promise.all(
      trashed.map((name) => fs.readFile(path.join(base, '.anchi-trash', name), 'utf8')),
    );
    assert.deepEqual(contents.sort(), ['second version', 'synthetic cell round trip']);
    await broker.revoke(id);
    directories.directories[0].mode = 'ro';
    await broker.activate(id);
    await assert.rejects(
      broker.request({ op: 'write', grant: id, path: 'report.txt', text: 'blocked' }),
      /READ_ONLY/,
    );
    await broker.revoke(id);
    await assert.rejects(
      broker.request({ op: 'read', grant: id, path: 'report.txt' }),
      /DIRECTORY_NOT_AUTHORIZED/,
    );
    console.log(
      'PASS: cell ↔ host bridge, text write/read, traversal/hidden-file denial, recoverable overwrite/delete, read-only and revocation.',
    );
  } finally {
    proc?.kill();
    await broker.revoke(id);
    await fs.rm(base, { recursive: true, force: true });
  }
}
main().catch(() => {
  console.error('LIVE_FILE_VERIFICATION_FAILED');
  process.exitCode = 1;
});
