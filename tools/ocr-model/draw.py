"""Draws the training lines as screens and documents show them, and cuts each one out with room around it.

    python draw.py <repository> <strings.jsonl> <out dir> [--seed N] [--edge-share 0.4] [--workers 4]

Two ways of drawing, as the check has (kit/node/ocr-check.ts):
- GDI and GDI+ (render-lines.ps1), one line to a picture: ClearType, grey anti-aliasing with and without grid fitting,
  and GDI's black-and-white, in the fonts a line's characters are all in (fonts.ps1).
- Edge, headless: pages of lines at 100% to 250% zoom, each line in its own font, size, weight and colours.
The fonts are the installed ones that are made for text, less the check's held-out fonts and their near twins, so the
held-out set stays unseen. Writes <out>\\crops\\<n>.png and <out>\\labels.jsonl, one line each:
{"f", "text", "kind", "how", "font", "px", "ink": [x0, y0, x1, y1]}, ink being where the text is in the crop.
"""
import html
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from recnet import CHARSET  # noqa: E402

# Text fonts by how often screens and documents use them. Fonts on every Windows PC first; Office's after.
FONTS = {
    'Segoe UI': 30, 'Segoe UI Semibold': 5, 'Segoe UI Light': 2, 'Segoe UI Semilight': 3, 'Segoe UI Black': 1,
    'Segoe UI Variable Text': 12, 'Segoe UI Variable Display': 4, 'Segoe UI Variable Small': 4,
    'Segoe UI Variable Text Semibold': 3, 'Segoe UI Variable Display Semib': 1,
    'Arial': 16, 'Arial Narrow': 1, 'Arial Black': 1, 'Calibri': 10, 'Calibri Light': 2, 'Tahoma': 8, 'Verdana': 7,
    'Microsoft Sans Serif': 5, 'Times New Roman': 9, 'Georgia': 6, 'Consolas': 12, 'Cascadia Code': 5, 'Cascadia Mono': 5,
    'Lucida Console': 4, 'Sitka Text': 2, 'Sitka Small': 1, 'Sitka Heading': 1, 'Bahnschrift': 2, 'Corbel': 2,
    'Constantia': 2, 'Franklin Gothic Book': 2, 'Franklin Gothic Medium': 1, 'Gill Sans MT': 2, 'Century Gothic': 2,
    'Garamond': 2, 'Bookman Old Style': 1, 'Century Schoolbook': 1, 'Century': 1, 'Comic Sans MS': 2, 'Impact': 1,
    'MS Reference Sans Serif': 1, 'Yu Gothic UI': 1, 'Malgun Gothic': 1, 'Microsoft YaHei UI': 1, 'Leelawadee UI': 1,
    'Nirmala UI': 1, 'Ebrima': 1, 'Gadugi': 1, 'Sylfaen': 1, 'Rockwell': 1, 'Perpetua': 1, 'Goudy Old Style': 1,
    'Baskerville Old Face': 1, 'Californian FB': 1, 'High Tower Text': 1, 'Lucida Bright': 1, 'Lucida Fax': 1,
    'Tw Cen MT': 1, 'Ink Free': 1, 'Segoe Print': 1, 'Dubai': 1, 'Javanese Text': 1, 'MS UI Gothic': 1,
}
# The held-out fonts' near twins: Book Antiqua is a Palatino, the other Lucida Sans faces Lucida Sans Unicode's family.
TWINS = {'Book Antiqua', 'Lucida Sans', 'Lucida Sans Typewriter', 'Cambria Math', 'Candara Light'}

THEMES = [  # (background, text): the check's four, then everyday ones
    ('#1E1E1E', '#D4D4D4'), ('#FFFFFF', '#1F1F1F'), ('#FFFFFF', '#6B7280'), ('#1D4ED8', '#FFFFFF'),
    ('#202020', '#FFFFFF'), ('#2B2B2B', '#E0E0E0'), ('#252526', '#CCCCCC'), ('#FFFFFF', '#24292F'),
    ('#FFFFFF', '#0067C0'), ('#FFFFFF', '#C42B1C'), ('#F3F3F3', '#1A1A1A'), ('#005FB8', '#FFFFFF'),
    ('#FFF4CE', '#3B2F00'), ('#0D1117', '#C9D1D9'), ('#FAFAFA', '#616161'), ('#000000', '#FFFFFF'),
    ('#FFFFFF', '#000000'), ('#EFF6FF', '#1E40AF'), ('#1E3A2F', '#B7F5C9'), ('#3A1F1F', '#FFB4A9'),
]
HOWS = {'gdiplus-cleartype': 4, 'gdi-cleartype': 3, 'gdiplus-aa': 2, 'gdiplus-aa-grid': 2, 'gdi-aa': 1, 'gdi-mono': 1}
PX = {9: 3, 10: 5, 11: 9, 12: 12, 13: 11, 14: 10, 15: 8, 16: 8, 17: 4, 18: 5, 20: 4, 22: 3, 24: 3, 26: 2, 28: 2, 31: 2,
      34: 2, 38: 1, 44: 1}
CSS_PX = {9: 2, 10: 4, 11: 7, 12: 12, 13: 12, 14: 12, 15: 8, 16: 10, 18: 5, 20: 4, 22: 2, 24: 3, 28: 2, 32: 1}
ZOOMS = {1: 5, 1.25: 4, 1.5: 4, 1.75: 2, 2: 3, 2.5: 1}
CONTEXT = 0.8  # room kept around the ink, in ink heights


def weighted(rnd, d):
    return rnd.choices(list(d), list(d.values()))[0]


def lum(hex_):
    c = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def theme(rnd):
    if rnd.random() < 0.7:
        return rnd.choice(THEMES)
    while True:
        bg = '#%02X%02X%02X' % tuple(rnd.randint(0, 255) for _ in range(3))
        fg = '#%02X%02X%02X' % tuple(rnd.randint(0, 255) for _ in range(3))
        if contrast(bg, fg) >= 2.5:
            return bg, fg


def rgb(hex_):
    return np.array([int(hex_[i:i + 2], 16) for i in (1, 3, 5)], np.int16)


def ink_box(a: np.ndarray, bg: np.ndarray, thresh=36):
    m = np.abs(a.astype(np.int16) - bg).sum(-1) > thresh
    ys, xs = np.nonzero(m)
    if len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def cut(a: np.ndarray, box, y_lo=0, y_hi=None):
    """The ink with CONTEXT room around it, inside the picture (and rows y_lo..y_hi); the ink's place in the cut."""
    x0, y0, x1, y1 = box
    h = y1 - y0
    m = int(np.ceil(CONTEXT * h))
    y_hi = a.shape[0] if y_hi is None else y_hi
    X0, Y0, X1, Y1 = max(0, x0 - m), max(y_lo, y0 - m), min(a.shape[1], x1 + m), min(y_hi, y1 + m)
    return a[Y0:Y1, X0:X1], [x0 - X0, y0 - Y0, x1 - X0, y1 - Y0]


def fonts_usable(repo: Path, coverage: dict):
    spec = json.loads((repo / 'kit' / 'spec' / 'ocr-check.json').read_text(encoding='utf-8'))
    held = set(spec['heldOut']['fonts'])
    bad = (held | TWINS) & set(FONTS)
    if bad:
        sys.exit(f'held-out fonts in the training fonts: {sorted(bad)}')
    return {f: w for f, w in FONTS.items() if f in coverage}


def run_ps(script: Path, prepend: str):
    tmp = Path(tempfile.mkdtemp(prefix='ocr-draw-'))
    try:
        p = tmp / 'run.ps1'
        p.write_text(prepend + '\n' + script.read_text(encoding='utf-8'), encoding='utf-8-sig')
        r = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(p)],
                           capture_output=True, text=True, encoding='utf-8')
        if r.returncode:
            raise RuntimeError(r.stderr[-2000:])
        return r.stdout
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def coverage_of(out: Path):
    f = out / 'fonts.json'
    if not f.exists():
        text = run_ps(HERE / 'fonts.ps1', "$Chars = '" + CHARSET.replace("'", "''") + "'")
        f.write_text(text, encoding='utf-8')
    return json.loads(f.read_text(encoding='utf-8'))


def draw_gdi(lines, out: Path, fonts, coverage, rnd, workers):
    raw = out / 'raw-gdi'
    raw.mkdir(parents=True, exist_ok=True)
    items = []
    for n, l in lines:
        ok = {f: w for f, w in fonts.items() if not set(l['text']) & set(coverage[f])}
        if not ok:
            continue
        font = weighted(rnd, ok)
        px = weighted(rnd, PX)
        bg, fg = theme(rnd)
        pad = max(4, int(px * 1.2))
        items.append(dict(id=f'{n:07d}', text=l['text'], font=font, bold=rnd.random() < 0.12, italic=rnd.random() < 0.05,
                          px=px, bg=bg, fg=fg, how=weighted(rnd, HOWS), padX=pad, padY=pad, kind=l['kind']))
    chunks = [items[i:i + 1500] for i in range(0, len(items), 1500)]

    def one(chunk):
        tmp = Path(tempfile.mkdtemp(prefix='ocr-jobs-'))
        try:
            jobs = tmp / 'jobs.json'
            jobs.write_text(json.dumps(dict(out=str(raw), items=chunk), ensure_ascii=False), encoding='utf-8')
            text = run_ps(HERE / 'render-lines.ps1', f"$Jobs = '{jobs}'")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        return {l.split('\t')[0] for l in text.splitlines() if l.count('\t') == 2 and 'error' not in l}

    with ThreadPoolExecutor(workers) as ex:
        done = set().union(*ex.map(one, chunks)) if chunks else set()
    rows = []
    for it in items:
        if it['id'] not in done:
            continue
        p = raw / f"{it['id']}.png"
        a = np.asarray(Image.open(p).convert('RGB'))
        box = ink_box(a, rgb(it['bg']))
        p.unlink()
        if box is None:
            continue
        crop, ink = cut(a, box)
        f = f"{it['id']}.png"
        Image.fromarray(crop).save(out / 'crops' / f)
        rows.append(dict(f=f, text=it['text'], kind=it['kind'], how=it['how'], font=it['font'], px=it['px'], ink=ink))
    shutil.rmtree(raw, ignore_errors=True)
    return rows


def find_edge():
    for base in (os.environ.get('ProgramFiles(x86)'), os.environ.get('ProgramFiles'), os.environ.get('LOCALAPPDATA')):
        if base:
            p = Path(base) / 'Microsoft' / 'Edge' / 'Application' / 'msedge.exe'
            if p.exists():
                return str(p)
    return None


def edge_shot(edge: str, page: Path, png: Path, zoom: float, w: int, h: int) -> bool:
    """One screenshot by Edge, headless, in a profile of its own: as ocr-check.ts's edgeShot."""
    profile = Path(tempfile.mkdtemp(prefix='ocr-edge-'))
    png.unlink(missing_ok=True)
    args = [edge, '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
            '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync',
            '--mute-audio', f'--user-data-dir={profile}', f'--force-device-scale-factor={zoom}', f'--window-size={w},{h}',
            f'--screenshot={png}', page.as_uri()]
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 90
    size = -1
    while time.time() < deadline:
        time.sleep(0.2)
        if not png.exists():
            continue
        s = png.stat().st_size
        if s > 0 and s == size:
            break
        size = s
    while time.time() < deadline and (profile / 'lockfile').exists():
        time.sleep(0.2)
    for _ in range(20):
        shutil.rmtree(profile, ignore_errors=True)
        if not profile.exists():
            break
        time.sleep(0.25)
    return png.exists() and png.stat().st_size > 0


WEIGHTS = {'Semibold': 600, 'Semib': 600, 'Semilight': 350, 'Light': 300, 'Black': 900}


def css_font(name: str, weight: int):
    """A GDI face name as a browser's family and weight: 'Segoe UI Semibold' is 'Segoe UI' at 600."""
    head, _, last = name.rpartition(' ')
    if last in WEIGHTS and head:
        return head, WEIGHTS[last]
    return name, weight


def draw_edge(lines, out: Path, fonts, rnd, workers):
    edge = find_edge()
    if not edge:
        print('no Edge here: no browser lines')
        return []
    raw = out / 'raw-edge'
    raw.mkdir(parents=True, exist_ok=True)
    pages, cur, height = [], [], 0
    W, MAX_H, TOP = 1600, 3000, 24
    page_theme = theme(rnd)
    for n, l in lines:
        size = weighted(rnd, CSS_PX)
        if len(l['text']) * size * 0.7 > W - 120:
            continue
        lh = int(round(size * 2.4))
        if height + lh > MAX_H - 2 * TOP and cur:
            pages.append((page_theme, cur))
            cur, height, page_theme = [], 0, theme(rnd)
        bg, fg = page_theme if rnd.random() < 0.8 else theme(rnd)
        family, weight = css_font(weighted(rnd, fonts), rnd.choices([400, 600, 700, 300], [70, 15, 12, 3])[0])
        cur.append(dict(n=n, l=l, size=size, lh=lh, y=height, bg=bg, fg=fg, font=family, weight=weight,
                        italic=rnd.random() < 0.05, indent=rnd.randint(8, 200)))
        height += lh
    if cur:
        pages.append((page_theme, cur))

    def one(k_page):
        k, (pt, rows) = k_page
        zoom = weighted(random.Random(k * 7919 + 1), ZOOMS)
        h = sum(r['lh'] for r in rows) + 2 * TOP
        body = ''.join(
            f"<div style=\"height:{r['lh']}px;line-height:{r['lh']}px;white-space:pre;overflow:hidden;padding-left:{r['indent']}px;"
            f"font-family:'{r['font']}';font-size:{r['size']}px;font-weight:{r['weight']};font-style:{'italic' if r['italic'] else 'normal'};"
            f"color:{r['fg']};background:{r['bg']}\">{html.escape(r['l']['text'])}</div>" for r in rows)
        page = raw / f'p{k:05d}.html'
        page.write_text(f'<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;background:{pt[0]}}}'
                        f'main{{padding:{TOP}px 0;overflow:hidden}}</style></head><body><main>{body}</main></body></html>',
                        encoding='utf-8')
        png = raw / f'p{k:05d}.png'
        got = []
        if not edge_shot(edge, page, png, zoom, W, h):
            return got
        a = np.asarray(Image.open(png).convert('RGB'))
        for r in rows:
            y_lo, y_hi = int(round((TOP + r['y']) * zoom)), int(round((TOP + r['y'] + r['lh']) * zoom))
            band = a[y_lo:y_hi]
            box = ink_box(band, rgb(r['bg']))
            if box is None or box[1] == 0 or box[3] >= band.shape[0] or box[2] >= a.shape[1] - 2:
                continue
            box = (box[0], box[1] + y_lo, box[2], box[3] + y_lo)
            crop, ink = cut(a, box, y_lo, y_hi)
            f = f"{r['n']:07d}.png"
            Image.fromarray(crop).save(out / 'crops' / f)
            got.append(dict(f=f, text=r['l']['text'], kind=r['l']['kind'], how=f'edge-{zoom}', font=r['font'],
                            px=r['size'], ink=ink))
        page.unlink(missing_ok=True)
        png.unlink(missing_ok=True)
        return got

    with ThreadPoolExecutor(workers) as ex:
        rows = [r for got in ex.map(one, enumerate(pages)) for r in got]
    shutil.rmtree(raw, ignore_errors=True)
    return rows


def main():
    repo, src, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve()
    arg = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
    seed, share, workers = arg('--seed', 1), arg('--edge-share', 0.4), arg('--workers', 4)
    rnd = random.Random(seed)
    (out / 'crops').mkdir(parents=True, exist_ok=True)
    coverage = coverage_of(out)
    fonts = fonts_usable(repo, coverage)
    lines = [json.loads(l) for l in src.read_text(encoding='utf-8').splitlines() if l.strip()]
    edge_lines, gdi_lines = [], []
    for n, l in enumerate(lines):
        (edge_lines if rnd.random() < share else gdi_lines).append((n, l))
    t = time.time()
    rows = draw_gdi(gdi_lines, out, fonts, coverage, rnd, workers)
    print(f'GDI: {len(rows)} of {len(gdi_lines)} lines in {time.time() - t:.0f} s')
    t = time.time()
    e = draw_edge(edge_lines, out, fonts, rnd, workers)
    print(f'Edge: {len(e)} of {len(edge_lines)} lines in {time.time() - t:.0f} s')
    rows += e
    rows.sort(key=lambda r: r['f'])
    (out / 'labels.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows), encoding='utf-8')


if __name__ == '__main__':
    main()
