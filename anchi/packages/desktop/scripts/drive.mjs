// Drives the built app for checks: starts Electron with a debugging port, runs steps against the
// page through the DevTools protocol, and quits.
//   node scripts/drive.mjs steps.json
// Steps: {"wait": ms} · {"waitFor": "css"} · {"click": "css"} · {"clickText": "text"}
//        {"type": ["css", "text"]} · {"key": "Enter"} · {"eval": "js"} (its value is printed)
//        {"shot": "file.png"} · {"size": [width, height]} · {"reload": true}
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const electron = createRequire(import.meta.url)('electron');
const port = 9300 + Math.floor(Math.random() * 500);
const app = spawn(electron, [`--remote-debugging-port=${port}`, join(root, 'dist/main.cjs')], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
      if (target) return target.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error('the app window did not appear');
}

const ws = new WebSocket(await page());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let next = 1;
const pending = new Map();
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  // The page's own errors, so a blank window explains itself.
  if (msg.method === 'Runtime.exceptionThrown') {
    console.error(
      `page exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`,
    );
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    console.error(
      `page ${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`,
    );
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    console.error(`page log: ${msg.params.entry.text}`);
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function send(method, params = {}) {
  const id = next++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, (msg) =>
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result),
    ),
  );
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails)
    throw new Error(res.exceptionDetails.exception?.description ?? 'evaluation failed');
  return res.result.value;
}

await send('Runtime.enable');
await send('Log.enable');

let failed = false;
try {
  for (const step of steps) {
    if (step.reload) await send('Page.reload', {});
    if (step.wait) await sleep(step.wait);
    if (step.size) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: step.size[0],
        height: step.size[1],
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    if (step.waitFor) {
      const ok = await evaluate(
        `new Promise((resolve) => { const t = Date.now(); const f = () => document.querySelector(${JSON.stringify(step.waitFor)}) ? resolve(true) : Date.now() - t > 60000 ? resolve(false) : setTimeout(f, 100); f(); })`,
      );
      if (!ok) throw new Error(`timed out waiting for ${step.waitFor}`);
    }
    if (step.click) {
      const ok = await evaluate(
        `(() => { const e = document.querySelector(${JSON.stringify(step.click)}); if (!e) return false; e.click(); return true; })()`,
      );
      if (!ok) throw new Error(`nothing matches ${step.click}`);
    }
    if (step.clickText) {
      const ok = await evaluate(
        `(() => { const e = [...document.querySelectorAll('button, a')].find((b) => b.textContent.includes(${JSON.stringify(step.clickText)})); if (!e) return false; e.click(); return true; })()`,
      );
      if (!ok) throw new Error(`no button says ${step.clickText}`);
    }
    if (step.type) {
      const [selector, text] = step.type;
      await evaluate(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value').set; set.call(e, ${JSON.stringify(text)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
    }
    if (step.key) {
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type,
          key: step.key,
          code: step.key,
          windowsVirtualKeyCode: step.key === 'Enter' ? 13 : 0,
        });
      }
    }
    if (step.eval) console.log(JSON.stringify(await evaluate(step.eval)));
    if (step.shot) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(step.shot, Buffer.from(data, 'base64'));
      console.log(`wrote ${step.shot}`);
    }
  }
} catch (err) {
  console.error(`step failed: ${err.message}`);
  failed = true;
} finally {
  ws.close();
  app.kill();
}
process.exit(failed ? 1 : 0);
