import fs from 'node:fs/promises';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const DIRECTORY = '/workspace/.pi-secure/sessions';
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export async function sessionPath(id, directory = DIRECTORY) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('INVALID_SESSION_ID');
  const files = await fs.readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const matches = files.filter(name => name.endsWith(`_${id}.jsonl`));
  if (matches.length !== 1) throw new Error('SESSION_NOT_FOUND');
  const file = path.join(directory,matches[0]);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16*1024*1024) throw new Error('INVALID_SESSION_FILE');
  const handle = await fs.open(file,'r');
  try {
    const buffer = Buffer.alloc(4096);
    const {bytesRead} = await handle.read(buffer,0,buffer.length,0);
    const header = JSON.parse(buffer.subarray(0,bytesRead).toString().split('\n')[0]);
    if (header.type !== 'session' || header.id !== id || header.cwd !== '/workspace') throw new Error('INVALID_SESSION_FILE');
  } finally { await handle.close(); }
  return file;
}
export async function openSessionManager(id) {
  if (id === undefined) return SessionManager.create('/workspace',DIRECTORY);
  return SessionManager.open(await sessionPath(id),DIRECTORY,'/workspace');
}
export async function listSessions() {
  // Filter before passing workspace-controlled files to the SDK's session parser.
  const files = await fs.readdir(DIRECTORY).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const result=[];
  for (const name of files.sort().reverse().slice(0,100)) {
    const id = name.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1];
    if (!id) continue;
    try {
      const file = await sessionPath(id);
      const stat = await fs.stat(file);
      result.push({session_id:id,session_file:file,modified:stat.mtime.toISOString()});
    } catch { /* Invalid workspace data is not a resumable session. */ }
  }
  return result;
}
