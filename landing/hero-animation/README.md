# Anchi hero animation

- `hero.html`: horizontal source, 960 × 420 logical pixels (1920 × 840 at 2×).
- `hero-v.html`: website source, 440 × 500 logical pixels (880 × 1000 at 2×).
- Both use `?lang=zh|en&theme=dark|light` and a 10.6-second loop. Text lives in `T`;
  connector labels live in `SVC` and `ROWS`. Only show implemented connectors.
- `render(t)` renders a deterministic frame when browser automation disables the playback loop.
- `cap2.py` exports frames using Python Playwright. Install Playwright/Chromium and ffmpeg
  separately; they are only needed for asset generation.

From this directory, export each language (use separate frame directories):

```bash
python3 cap2.py hero-v.html 'lang=en&theme=dark' 25 /tmp/anchi-frames-en
ffmpeg -y -framerate 25 -i /tmp/anchi-frames-en/f%04d.png -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart ../dist/anchi-hero-vertical-en-dark.mp4
ffmpeg -y -i /tmp/anchi-frames-en/f0000.png -frames:v 1 ../dist/anchi-hero-vertical-en-dark.jpg
```

Repeat with `zh`. Commit both language videos and posters whenever the diagram changes;
a source-only change leaves the deployed page unchanged. Review the first frame and a middle
frame, confirm dimensions and duration, and preview both pages on desktop and mobile.
The site uses the posters for reduced motion and social previews. These are explanatory
animations; the actual TUI preview in the root README is rendered separately with example data.
