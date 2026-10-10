import sys, os, pathlib
from playwright.sync_api import sync_playwright
html, query, fps, outdir = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
times = [float(x) for x in sys.argv[5].split(',')] if len(sys.argv) > 5 else None
os.makedirs(outdir, exist_ok=True)
url = pathlib.Path(html).resolve().as_uri() + '?' + query
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 960, 'height': 420}, device_scale_factor=2)
    pg.goto(url); pg.wait_for_timeout(300)
    w,h=pg.evaluate('[document.getElementById("stage").offsetWidth,document.getElementById("stage").offsetHeight]'); pg.set_viewport_size({'width':w,'height':h})
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    total = pg.evaluate('TOTAL')
    for i, t in enumerate(times or [i / fps for i in range(int(round(total * fps)))]):
        pg.evaluate(f'render({t})'); pg.screenshot(path=f'{outdir}/f{i:04d}.png')
    print(errs); b.close()
