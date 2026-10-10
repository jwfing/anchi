# Anchi hero animation

官网 hero 区的动画源文件与导出结果。

## 文件
- `hero.html` — 横版动画源（960×420 逻辑尺寸，2x 导出为 1920×840，循环 10.6s）。
  - URL 参数：`?lang=zh|en&theme=dark|light`；直接用浏览器打开可实时预览。
  - 文案在 `T` 字典；配色在 `:root` / `.light` CSS 变量；
    请求时间轴在 `FLOWS`（cell → 服务）与 `render(t)` 中的相对时间常量。
  - `render(t)` 是纯函数，导出时逐帧调用，结果可复现。
- `hero-v.html` — 竖版（440×500 逻辑尺寸，2x 导出 880×1000），尺寸和风格对齐 landing 首屏右栏的 `.fleet-figure`。**推荐用于官网 hero**；参数与 `hero.html` 相同。
- `cap2.py` — 用 Playwright 逐帧截图：`python3 cap2.py hero.html "lang=zh&theme=dark" 25 frames`
- `compare/` — 竖版 vs 横版放进现有 landing 首屏的对比截图（桌面 / 手机）。
- `out/` — 导出的 GIF（1920 宽）和 MP4（官网推荐用 MP4）。
- `v1-vertical/` — 早期竖版、逐步讲解版本（`anim.html` + `capture.py`）。

## 重新导出
```bash
python3 cap2.py hero.html "lang=zh&theme=dark" 25 frames
gifski --fps 25 --quality 85 --width 1920 -o out/anchi-hero-zh-dark.gif frames/f*.png
ffmpeg -framerate 25 -i frames/f%04d.png -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart out/anchi-hero-zh-dark.mp4
```
依赖：`pip install playwright && playwright install chromium`，`brew install gifski ffmpeg`。

## 官网嵌入
推荐用竖版 MP4 替换 `landing/dist/index.html`（及 `zh/`、`en/`）中 `.fleet-figure` 里的 `.fleet-console`，保留 figcaption：
```html
<video src="/anchi-hero-vertical-zh-dark.mp4" autoplay muted loop playsinline
       aria-label="agent 在隔离 cell 中只持有假凭据，请求经可信网关替换为真实凭据后访问外部服务"
       style="width:100%;display:block"></video>
```
英文页用 `-en-dark`。横版 `anchi-hero-*` 适合 GitHub README / 社交媒体。
