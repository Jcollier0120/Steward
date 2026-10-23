"""The check's scoring (ocr-check.ts' norm, lev, scoreText), for engines run outside the kit.

    python score.py <fixtures dir> <texts.json: {file: text}> [<texts2.json> ...]
"""
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path


def norm(s: str) -> str:
    s = unicodedata.normalize('NFC', s)
    s = re.sub('[‘’]', "'", s)
    s = re.sub('[“”]', '"', s)
    s = re.sub('[–—]', '-', s)
    return re.sub(r'\s+', ' ', s).strip()


def lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        ca = a[i - 1]
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if ca == b[j - 1] else 1))
        prev = cur
    return prev[len(b)]


def score(lines, text):
    want = norm(' '.join(lines))
    got = norm(text)
    words = Counter(got.split(' '))
    ok = total = 0
    for w in want.split(' '):
        if not w:
            continue
        total += 1
        if words[w] > 0:
            ok += 1
            words[w] -= 1
    missed = [l for l in lines if norm(l) not in got]
    return dict(chars=len(want), edits=lev(want, got), wordsOk=ok, wordsAll=total, linesOk=len(lines) - len(missed), lines=len(lines), missed=missed)


ORDER = ['screen', 'page', 'browser', 'held-out']


def report(fx: Path, texts: dict, name: str, quiet=False):
    truth = json.loads((fx / 'truth.json').read_text(encoding='utf-8-sig'))
    groups = defaultdict(lambda: Counter())
    rows = {}
    for t in truth:
        if t['group'] == 'pdf scan':
            continue
        s = score(t['lines'], texts.get(t['file'], ''))
        rows[t['file']] = s
        for k in ('chars', 'edits', 'wordsOk', 'wordsAll', 'linesOk', 'lines'):
            groups[t['group']][k] += s[k]
            groups['all'][k] += s[k]
            if t['set'] in ('screen', 'page'):
                groups["the bench's 25"][k] += s[k]

    def key(g):
        k = next((i for i, p in enumerate(ORDER) if g.startswith(p)), 9)
        n = re.sub(r'^\D+', '', g)
        return (k, float(re.match(r'[\d.]+', n).group()) if re.match(r'[\d.]+', n) else 0, g)

    out = [f'{name}', f"  {'group':22} {'chars':>7} {'words':>7} {'lines':>9}"]
    for g in sorted(groups, key=key):
        c = groups[g]
        out.append(f"  {g:22} {100 * (c['chars'] - c['edits']) / c['chars']:6.1f}% {100 * c['wordsOk'] / c['wordsAll']:6.1f}% {c['linesOk']:>4}/{c['lines']:<4}")
    if not quiet:
        print('\n'.join(out))
    return groups, rows


if __name__ == '__main__':
    fx = Path(sys.argv[1])
    for p in sys.argv[2:]:
        report(fx, json.loads(Path(p).read_text(encoding='utf-8')), Path(p).stem)
