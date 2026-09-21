import { randomUUID } from 'node:crypto';
const pending = new Map();
export function receiveHostResult(value) {
  if (value?.op !== 'host_file_result') return false;
  const item = pending.get(value.id);
  if (item) {
    pending.delete(value.id);
    item.finish(value);
  }
  return true;
}
export function hostFileRequest(request, notify, signal) {
  if (signal?.aborted) return Promise.reject(Error('ABORTED'));
  if (pending.size >= 8) return Promise.reject(Error('FILE_QUEUE_FULL'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(Error('ABORTED'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error('HOST_FILE_TIMEOUT'));
    }, 30000);
    pending.set(id, {
      finish: (value) => {
        cleanup();
        value.ok ? resolve(value.result) : reject(Error(value.error || 'FILE_OPERATION_DENIED'));
      },
    });
    signal?.addEventListener('abort', abort, { once: true });
    notify({ type: 'host_file_request', id, request });
  });
}
