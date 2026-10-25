// Renders assets/icon.svg into assets/icon.png (1024 px, transparent outside the tile, with the
// margin docks expect). Run with Electron after changing the mark:
//   node scripts/build.mjs && npx electron scripts/icon.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 1024;
// macOS app icons draw their tile on about 80 % of the canvas.
const TILE = Math.round(SIZE * 0.805);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = readFileSync(join(root, 'assets/icon.svg'), 'utf8');
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"
      style="position:absolute;width:${TILE}px;height:${TILE}px;left:${(SIZE - TILE) / 2}px;top:${(SIZE - TILE) / 2}px">
    </body></html>`;
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(1);
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const png = image.resize({ width: SIZE, height: SIZE }).toPNG();
  writeFileSync(join(root, 'assets/icon.png'), png);
  const corner = image.toBitmap().subarray(0, 4);
  console.log(`wrote assets/icon.png, ${SIZE} px, corner alpha ${corner[3]}`);
  app.quit();
});
