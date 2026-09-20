const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
function validateCommand(op, args = {}) {
  if (typeof op !== 'string') throw Error('INVALID_COMMAND');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('INVALID_ARGUMENTS');
  const allowed = {
    status: [],
    sessions: [],
    history: [],
    new: [],
    cancel: [],
    prompt: ['text'],
    resume: ['session_id'],
  };
  if (!Object.hasOwn(allowed, op) || Object.keys(args).some((k) => !allowed[op].includes(k)))
    throw Error('INVALID_COMMAND');
  if (
    op === 'prompt' &&
    (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 8000)
  )
    throw Error('INVALID_PROMPT');
  if (
    op === 'resume' &&
    (typeof args.session_id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args.session_id))
  )
    throw Error('INVALID_SESSION');
  return { op, ...args };
}
function overlaps(a, b) {
  return (
    a === b ||
    a.startsWith(b + path.sep) ||
    b.startsWith(a + path.sep) ||
    a === path.parse(a).root ||
    b === path.parse(b).root
  );
}
class Lines {
  constructor(onValue, onError) {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.failed = false;
    this.onValue = onValue;
    this.onError = onError;
  }
  push(chunk) {
    if (this.failed) return;
    this.buffer += this.decoder.write(chunk);
    let n;
    while ((n = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, n);
      this.buffer = this.buffer.slice(n + 1);
      if (Buffer.byteLength(line) > 65536) return this.fail();
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return this.fail();
        this.onValue(value);
      } catch {
        return this.fail();
      }
    }
    if (Buffer.byteLength(this.buffer) > 65536) this.fail();
  }
  fail() {
    this.failed = true;
    this.buffer = '';
    this.onError(Error('INVALID_AGENT_STREAM'));
  }
}
module.exports = { validateCommand, overlaps, Lines };
