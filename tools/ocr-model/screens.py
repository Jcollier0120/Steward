"""Draws whole screens and pages for the detector to learn from (distill_det.py): windows with sidebars, menus, tabs,
settings rows, buttons, fields, tables, code and status bars, and documents of headings and paragraphs, as Edge draws
them, headless, at 100% to 250%.

    python screens.py <repository> <strings.jsonl> <fonts.json> <out dir> <count> [--seed N] [--workers N]

The text is the training lines' (strings.py: none of it the check's), in the training fonts (draw.py's, less the
check's held-out fonts and their twins); fonts.json is the coverage draw.py wrote beside its crops. The detector is
taught by its teacher's answers, not by boxes, so nothing here is labelled: each screen is a PNG in <out>.
"""
import html
import json
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from draw import CSS_PX, ZOOMS, contrast, css_font, edge_shot, find_edge, fonts_usable, theme, weighted  # noqa: E402

SIZES = [(1280, 800), (1366, 768), (1440, 900), (1600, 1000), (1920, 1080), (1024, 768), (900, 1200), (800, 600)]
MONO = ['Consolas', 'Cascadia Mono', 'Cascadia Code', 'Lucida Console']
ACCENTS = ['#0067C0', '#005FB8', '#C42B1C', '#107C10', '#8764B8', '#CA5010', '#038387', '#4F6BED', '#E3008C', '#498205']


def shade(hex_, k):
    """The colour moved k (-1..1) towards white (k > 0) or black."""
    c = [int(hex_[i:i + 2], 16) for i in (1, 3, 5)]
    c = [round(x + (255 - x) * k) if k > 0 else round(x * (1 + k)) for x in c]
    return '#%02X%02X%02X' % tuple(max(0, min(255, x)) for x in c)


class Page:
    def __init__(self, rnd, texts, fonts):
        self.r, self.texts, self.fonts = rnd, texts, fonts
        self.bg, self.fg = theme(rnd)
        dark = sum(int(self.bg[i:i + 2], 16) for i in (1, 3, 5)) < 384
        self.panel = shade(self.bg, 0.06 if dark else -0.04)
        self.line = shade(self.bg, 0.18 if dark else -0.12)
        self.dim = shade(self.fg, -0.35 if not dark else -0.3) if contrast(shade(self.fg, -0.35), self.bg) > 2.5 else self.fg
        self.accent = rnd.choice(ACCENTS)
        self.family, self.weight = css_font(weighted(rnd, fonts), 400)
        self.size = weighted(rnd, CSS_PX)

    def text(self, short=False, n=None):
        t = self.r.choice(self.texts)
        if short or n:
            words = t.split()
            k = n or self.r.randint(1, 4)
            start = self.r.randint(0, max(0, len(words) - k))
            t = ' '.join(words[start:start + k]) or t[:20]
        return html.escape(t)

    def font(self, size=None, mono=False, weight=None):
        fam = self.r.choice([f for f in MONO if f in self.fonts] or [self.family]) if mono else self.family
        return f"font-family:'{fam}';font-size:{size or self.size}px;font-weight:{weight or self.weight}"

    def block(self, depth=0):
        r = self.r
        kind = r.choices(['para', 'list', 'rows', 'buttons', 'fields', 'table', 'code', 'cards', 'heading', 'picture'],
                         [5, 3, 4, 2, 2, 2, 1, 2, 2, 1])[0]
        s = self.size
        if kind == 'heading':
            return f"<h2 style=\"{self.font(int(s * r.uniform(1.3, 2.2)), weight=r.choice([600, 700]))};margin:{s}px 0 {s // 2}px\">{self.text(n=r.randint(1, 6))}</h2>"
        if kind == 'para':
            body = ' '.join(self.text() for _ in range(r.randint(1, 5)))
            align = r.choice(['left', 'left', 'justify'])
            return f"<p style=\"{self.font()};line-height:{r.uniform(1.2, 1.7):.2f};text-align:{align};max-width:{r.randint(40, 95)}%\">{body}</p>"
        if kind == 'list':
            items = ''.join(f'<li>{self.text(short=r.random() < 0.5)}</li>' for _ in range(r.randint(2, 8)))
            tag = r.choice(['ul', 'ol'])
            return f"<{tag} style=\"{self.font()};line-height:1.6\">{items}</{tag}>"
        if kind == 'rows':
            rows = ''.join(
                f"<div style=\"display:flex;justify-content:space-between;padding:{s * 0.7:.0f}px {s}px;border-bottom:1px solid {self.line}\">"
                f"<span>{self.text(short=True)}</span><span style=\"color:{self.dim}\">{self.text(n=r.randint(1, 3))}</span></div>"
                for _ in range(r.randint(2, 7)))
            return f"<div style=\"{self.font()};background:{self.panel};border-radius:{r.choice([0, 4, 8])}px;margin:{s // 2}px 0\">{rows}</div>"
        if kind == 'buttons':
            out = []
            for _ in range(r.randint(1, 4)):
                fill = r.random() < 0.5
                bg, fg = (self.accent, '#FFFFFF') if fill else (self.panel, self.fg)
                out.append(f"<span style=\"display:inline-block;background:{bg};color:{fg};border:1px solid {self.line};"
                           f"border-radius:{r.choice([2, 4, 6, 16])}px;padding:{s * 0.4:.0f}px {s:.0f}px;margin-right:{s * 0.6:.0f}px\">{self.text(n=r.randint(1, 3))}</span>")
            return f"<div style=\"{self.font()};margin:{s}px 0\">{''.join(out)}</div>"
        if kind == 'fields':
            out = []
            for _ in range(r.randint(1, 4)):
                out.append(f"<div style=\"margin:{s * 0.6:.0f}px 0\"><div style=\"color:{self.dim};margin-bottom:4px\">{self.text(short=True)}</div>"
                           f"<div style=\"border:1px solid {self.line};border-radius:4px;padding:{s * 0.35:.0f}px {s * 0.5:.0f}px;width:{r.randint(30, 70)}%;"
                           f"background:{shade(self.bg, 0.02)}\">{self.text(short=r.random() < 0.6)}</div></div>")
            return f"<div style=\"{self.font()}\">{''.join(out)}</div>"
        if kind == 'table':
            cols = r.randint(2, 5)
            head = ''.join(f"<th style=\"text-align:left;padding:4px 10px;border-bottom:2px solid {self.line}\">{self.text(n=r.randint(1, 2))}</th>" for _ in range(cols))
            body = ''.join('<tr>' + ''.join(f"<td style=\"padding:4px 10px;border-bottom:1px solid {self.line}\">{self.text(n=r.randint(1, 3))}</td>" for _ in range(cols)) + '</tr>'
                           for _ in range(r.randint(2, 8)))
            return f"<table style=\"{self.font()};border-collapse:collapse;margin:{s}px 0\"><tr>{head}</tr>{body}</table>"
        if kind == 'code':
            body = '\n'.join(' ' * (4 * r.randint(0, 3)) + self.text() for _ in range(r.randint(2, 10)))
            return f"<pre style=\"{self.font(mono=True)};background:{self.panel};padding:{s}px;border-radius:4px;overflow:hidden\">{body}</pre>"
        if kind == 'cards':
            cards = ''.join(
                f"<div style=\"flex:1;min-width:120px;background:{self.panel};border:1px solid {self.line};border-radius:8px;padding:{s}px;margin:6px\">"
                f"<div style=\"font-weight:600\">{self.text(n=r.randint(1, 3))}</div><div style=\"color:{self.dim};margin-top:6px\">{self.text()}</div></div>"
                for _ in range(r.randint(2, 4)))
            return f"<div style=\"{self.font()};display:flex;flex-wrap:wrap\">{cards}</div>"
        # A picture: no text in it, so the detector learns to leave such things alone.
        a, b = shade(self.accent, r.uniform(-0.5, 0.5)), shade(self.accent, r.uniform(-0.5, 0.8))
        return (f"<div style=\"width:{r.randint(80, 400)}px;height:{r.randint(40, 220)}px;border-radius:{r.choice([0, 8, 999])}px;"
                f"background:linear-gradient({r.randint(0, 360)}deg,{a},{b});margin:{s}px 0\"></div>")

    def window(self):
        r, s = self.r, self.size
        nav = ''
        if r.random() < 0.7:
            items = ''.join(
                f"<div style=\"padding:{s * 0.5:.0f}px {s}px;border-radius:4px;{'background:' + shade(self.panel, 0.08) + ';' if k == 0 else ''}\">"
                f"{'&#9632;&nbsp; ' if r.random() < 0.3 else ''}{self.text(n=r.randint(1, 3))}</div>" for k in range(r.randint(4, 14)))
            nav = f"<nav style=\"width:{r.randint(160, 300)}px;flex:none;background:{self.panel};padding:{s}px 6px;{self.font()}\">{items}</nav>"
        bar = ''
        if r.random() < 0.7:
            tabs = ''.join(f"<span style=\"padding:{s * 0.5:.0f}px {s}px;{'border-bottom:2px solid ' + self.accent if k == 0 else ''}\">{self.text(n=r.randint(1, 2))}</span>"
                           for k in range(r.randint(2, 7)))
            bar = f"<div style=\"{self.font()};border-bottom:1px solid {self.line};padding:4px {s}px;white-space:nowrap;overflow:hidden\">{tabs}</div>"
        main = ''.join(self.block() for _ in range(r.randint(3, 9)))
        status = ''
        if r.random() < 0.5:
            parts = '&nbsp;&nbsp;&nbsp;'.join(self.text(n=r.randint(1, 3)) for _ in range(r.randint(3, 8)))
            status = f"<div style=\"{self.font(max(9, s - 2))};background:{r.choice([self.accent, self.panel])};color:#FFFFFF;padding:3px 10px;white-space:nowrap;overflow:hidden\">{parts}</div>"
        title = f"<div style=\"{self.font(max(9, s - 1))};padding:6px 12px;background:{self.panel};border-bottom:1px solid {self.line}\">{self.text(n=r.randint(1, 5))}</div>"
        return (f"{title}<div style=\"display:flex;flex:1;min-height:0\">{nav}<div style=\"flex:1;display:flex;flex-direction:column;min-width:0\">{bar}"
                f"<main style=\"flex:1;padding:{s}px {s * 1.5:.0f}px;overflow:hidden\">{main}</main></div></div>{status}")

    def document(self):
        r, s = self.r, self.size
        cols = r.choice([1, 1, 1, 2])
        body = ''.join(self.block() if r.random() < 0.3 else
                       f"<p style=\"{self.font()};line-height:{r.uniform(1.25, 1.6):.2f};text-align:{r.choice(['left', 'justify'])}\">{' '.join(self.text() for _ in range(r.randint(2, 7)))}</p>"
                       for _ in range(r.randint(4, 12)))
        head = f"<h1 style=\"{self.font(int(s * r.uniform(1.6, 2.6)), weight=700)}\">{self.text(n=r.randint(2, 8))}</h1>"
        return (f"<div style=\"max-width:{r.randint(600, 1100)}px;margin:{s * 2}px auto;padding:{s * 2}px {s * 3}px;background:{self.panel};"
                f"column-count:{cols};column-gap:{s * 2}px\">{head}{body}</div>")

    def html(self, w, h):
        inner = self.window() if self.r.random() < 0.65 else self.document()
        return (f'<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;height:100%;background:{self.bg};color:{self.fg}}}'
                f'body{{display:flex;flex-direction:column;overflow:hidden;width:{w}px;height:{h}px}}*{{box-sizing:border-box}}</style></head>'
                f'<body>{inner}</body></html>')


def main():
    repo, src, cov, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]).resolve()
    count = int(sys.argv[5])
    arg = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
    seed, workers = arg('--seed', 1), arg('--workers', 4)
    fonts = fonts_usable(repo, json.loads(cov.read_text(encoding='utf-8')))
    texts = [json.loads(l)['text'] for l in src.read_text(encoding='utf-8').splitlines() if l.strip()]
    edge = find_edge()
    if not edge:
        sys.exit('no Edge here')
    out.mkdir(parents=True, exist_ok=True)

    def one(k):
        png = out / f's{k:05d}.png'
        if png.exists():
            return True
        r = random.Random(seed * 1_000_003 + k)
        w, h = r.choice(SIZES)
        zoom = weighted(r, ZOOMS)
        page = out / f's{k:05d}.html'
        # A screen's text, in fonts that have every character it needs.
        p = Page(r, texts, fonts)
        page.write_text(p.html(w, h), encoding='utf-8')
        ok = edge_shot(edge, page, png, zoom, w, h)
        page.unlink(missing_ok=True)
        return ok

    with ThreadPoolExecutor(workers) as ex:
        done = sum(ex.map(one, range(count)))
    print(f'{done} of {count} screens in {out}')


if __name__ == '__main__':
    main()
