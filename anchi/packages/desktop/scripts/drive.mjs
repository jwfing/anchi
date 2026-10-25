// Drives the built app for checks: starts Electron with a debugging port, runs steps against the
// page through the DevTools protocol, and quits.
//   node scripts/drive.mjs steps.json [profile-dir]
// ANCHI_DRIVE_APP=<executable> drives a packaged app instead of the checkout's build.
// The app runs in its own profile (a new temporary one unless given), never the user's: an open
// Anchi window holds that profile's storage.
// Steps: {"wait": ms} · {"waitFor": "css"} · {"click": "css"} · {"clickText": "text"}
//        {"type": ["css", "text"]} · {"key": "Enter"} · {"eval": "js"} (its value is printed)
//        {"shot": "file.png"} · {"size": [width, height, scale?]} · {"reload": true}
//        {"drag": ["css", dx]} (a mouse drag from the element's centre, dx pixels across)
//        {"wheel": ["css", dy]} (a mouse wheel turn over the element's centre, dy pixels down)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const electron = createRequire(import.meta.url)('electron');
const port = 9300 + Math.floor(Math.random() * 500);
const profile = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'anchi-drive-'));
const packaged = process.env.ANCHI_DRIVE_APP;
const app = spawn(
  packaged ?? electron,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...(packaged ? [] : [join(root, 'dist/main.cjs')]),
  ],
  { stdio: ['ignore', 'inherit', 'inherit'], env: process.env },
);
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

/** Quits as a user would, so the window's storage is written; kills the app if that hangs. */
async function quit() {
  const exited = new Promise((r) => app.once('exit', r));
  try {
    const { webSocketDebuggerUrl } = await (
      await fetch(`http://127.0.0.1:${port}/json/version`)
    ).json();
    const browser = new WebSocket(webSocketDebuggerUrl);
    await new Promise((r) => browser.addEventListener('open', r, { once: true }));
    browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  } catch {
    // Already gone, or the port is closed: the kill below decides.
  }
  if (!(await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]))) app.kill();
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
        deviceScaleFactor: step.size[2] ?? 1,
        mobile: false,
      });
    }
    if (step.waitFor) {
      // Polled from here, not in the page: a page that loads or reloads meanwhile destroys the
      // context an in-page wait runs in, which fails the check although the element appears.
      const deadline = Date.now() + 60000;
      let ok = false;
      while (!ok && Date.now() < deadline) {
        ok = await evaluate(`!!document.querySelector(${JSON.stringify(step.waitFor)})`).catch(
          () => false,
        );
        if (!ok) await sleep(100);
      }
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
    if (step.wheel) {
      const [selector, dy] = step.wheel;
      const at = await evaluate(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
      );
      if (!at) throw new Error(`nothing matches ${selector}`);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: at[0],
        y: at[1],
        deltaX: 0,
        deltaY: dy,
      });
      await sleep(300);
    }
    if (step.drag) {
      const [selector, dx] = step.drag;
      const at = await evaluate(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
      );
      if (!at) throw new Error(`nothing matches ${selector}`);
      const mouse = (type, x, buttons) =>
        send('Input.dispatchMouseEvent', {
          type,
          x,
          y: at[1],
          button: 'left',
          buttons,
          clickCount: 1,
        });
      await mouse('mousePressed', at[0], 1);
      for (let i = 1; i <= 10; i++) await mouse('mouseMoved', at[0] + (dx * i) / 10, 1);
      await mouse('mouseReleased', at[0] + dx, 0);
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
  await quit();
}
process.exit(failed ? 1 : 0);
