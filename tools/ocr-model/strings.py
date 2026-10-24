"""The training lines: text of the kinds screens and documents show, none of it the check's.

    python strings.py <repository> <count> <out.jsonl> [--seed N]

Each line is {"text", "kind"}. The kinds: prose and code taken from the repository's own Markdown and source files,
and made-up interface text, paths, addresses, numbers, accented words, typography and character soup (random
characters, so the model reads what is drawn rather than guessing from words it knows). Every line that shares 16
characters in a row with any of the check's strings (kit/spec/ocr-check.json, the bench's and the held-out set's) is
left out, so the check measures text the model has never seen.
"""
import json
import random
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from recnet import CHARSET  # noqa: E402

ALLOWED = set(CHARSET)
GRAM = 16


def squash(s: str) -> str:
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFC', s)).strip()


def grams(s: str):
    s = squash(s).lower()
    return {s[i:i + GRAM] for i in range(max(1, len(s) - GRAM + 1))}


def check_strings(repo: Path):
    spec = json.loads((repo / 'kit' / 'spec' / 'ocr-check.json').read_text(encoding='utf-8'))
    out = list(spec['ui']) + list(spec['prose']) + list(spec['heldOut']['ui']) + list(spec['heldOut']['prose'])
    return out


def chunks(text: str, rnd: random.Random, lo=8, hi=95):
    """A paragraph cut at word boundaries into lines of lo..hi characters."""
    words = text.split()
    i = 0
    while i < len(words):
        want = rnd.randint(lo, hi)
        line = words[i]
        i += 1
        while i < len(words) and len(line) + 1 + len(words[i]) <= want:
            line += ' ' + words[i]
            i += 1
        yield line


def repo_text(repo: Path, rnd: random.Random):
    """Prose from the Markdown, code lines from the sources: the repository's own files, read as they are."""
    prose, code, words = [], [], set()
    for p in sorted(repo.rglob('*')):
        rel = p.relative_to(repo).as_posix()
        if any(part in rel for part in ('node_modules/', '.git/', 'fixture/', 'tools/ocr-model/')) or not p.is_file():
            continue
        if p.suffix == '.md':
            t = p.read_text(encoding='utf-8', errors='ignore')
            t = re.sub(r'```.*?```', ' ', t, flags=re.S)
            for para in re.split(r'\n\s*\n', t):
                para = re.sub(r'[#>*_`|]+', ' ', para)
                para = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', para)
                para = squash(para)
                if len(para) > 20:
                    prose.extend(chunks(para, rnd))
                    words.update(w for w in re.findall(r"[A-Za-z][a-z]{1,14}", para))
        elif p.suffix in ('.ts', '.ps1', '.cs', '.py') and p.stat().st_size < 400_000:
            for l in p.read_text(encoding='utf-8', errors='ignore').splitlines():
                l = l.strip()
                if 6 <= len(l) <= 100:
                    code.append(l)
    return prose, code, sorted(words)


FIRST = ['Alex', 'Sam', 'Priya', 'Mateo', 'Chen', 'Fatima', 'Noah', 'Aisha', 'Lukas', 'Yuki', 'Olu', 'Ines', 'Ravi', 'Mia',
         'Tomás', 'Zoë', 'Björn', 'Chloé', 'José', 'Søren', 'Anaïs', 'Łukasz', 'Kai', 'Elena', 'Omar', 'Hana', 'Diego', 'Freya']
LAST = ['Okafor', 'Lindqvist', 'Moreau', 'Nakamura', 'Patel', 'García', 'Müller', 'O\'Brien', 'Kowalski', 'Haddad',
        'Fernández', 'Nguyen', 'Schröder', 'Rossi', 'Dubois', 'Iqbal', 'Larsen', 'Ibáñez', 'Kim', 'Novak', 'Mensah']
EXT = ['txt', 'pdf', 'docx', 'xlsx', 'png', 'jpg', 'json', 'ts', 'js', 'py', 'cs', 'ps1', 'md', 'zip', 'exe', 'dll',
       'log', 'csv', 'mp4', 'html', 'yml', 'onnx', 'msi', 'bat', 'ini', 'xml', 'svg', 'gz', 'tar', 'cfg']
TLD = ['com', 'org', 'net', 'io', 'dev', 'co.uk', 'de', 'fr', 'app', 'ai', 'gov', 'edu', 'info', 'example']
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November',
          'December']
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
UNITS = ['KB', 'MB', 'GB', 'TB', 'ms', 's', 'min', 'hr', 'px', 'pt', '%', 'fps', 'kbps', 'Mbps', 'GHz', 'MHz', 'W', 'mAh',
         'dpi', '°C', '°F', 'km', 'mi', 'kg', 'lb', 'mm', 'cm']
SYMBOLS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
TYPO = '€£¥¢©®™°±×÷µ§¶•…–—‘’“”«»¿¡→←↑↓✓·'
ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIV', 'XV', 'XX']
ACCENTS = {'a': 'àáâãäå', 'e': 'èéêë', 'i': 'ìíîï', 'o': 'òóôõöø', 'u': 'ùúûü', 'c': 'ç', 'n': 'ñ', 'y': 'ýÿ',
           'A': 'ÀÁÂÃÄÅ', 'E': 'ÈÉÊË', 'I': 'ÌÍÎÏ', 'O': 'ÒÓÔÕÖØ', 'U': 'ÙÚÛÜ', 'C': 'Ç', 'N': 'Ñ', 'Y': 'Ý'}


class Gen:
    def __init__(self, rnd: random.Random, prose, code, words):
        self.r, self.prose, self.code, self.words = rnd, prose, code, words

    def w(self, cap=False):
        x = self.r.choice(self.words)
        x = x.lower() if not cap else x[:1].upper() + x[1:].lower()
        return x

    def ws(self, lo, hi, cap_first=True):
        n = self.r.randint(lo, hi)
        out = [self.w() for _ in range(n)]
        if cap_first and out:
            out[0] = out[0][:1].upper() + out[0][1:]
        return ' '.join(out)

    def name(self):
        return f'{self.r.choice(FIRST)} {self.r.choice(LAST)}'

    def num(self):
        r = self.r
        k = r.randint(0, 9)
        if k == 0:
            return str(r.randint(0, 9))
        if k <= 3:
            return str(r.randint(10, 9999))
        if k <= 5:
            return f'{r.randint(1000, 9_999_999):,}'
        if k <= 7:
            return f'{r.uniform(0, 1000):.{r.randint(1, 3)}f}'
        return f'{r.randint(0, 100)}{r.choice(["", "%", "x", "k"])}'

    def date(self):
        r = self.r
        y, m, d = r.randint(1990, 2039), r.randint(1, 12), r.randint(1, 28)
        return r.choice([
            f'{y}-{m:02d}-{d:02d}', f'{d}/{m}/{y}', f'{m}/{d}/{y}', f'{d:02d}.{m:02d}.{y}', f'{d} {MONTHS[m - 1]} {y}',
            f'{MONTHS[m - 1]} {d}, {y}', f'{d} {MONTHS[m - 1][:3]} {y}', f'{DAYS[r.randint(0, 6)]}, {d} {MONTHS[m - 1]}',
            f'{DAYS[r.randint(0, 6)][:3]} {MONTHS[m - 1][:3]} {d}', f'{y}{m:02d}{d:02d}'])

    def time(self):
        r = self.r
        h, m, s = r.randint(0, 23), r.randint(0, 59), r.randint(0, 59)
        return r.choice([f'{h:02d}:{m:02d}', f'{h}:{m:02d}:{s:02d}', f'{(h % 12) or 12}:{m:02d} {"AM" if h < 12 else "PM"}',
                         f'{h:02d}{m:02d}{s:02d}', f'{h}h {m}m', f'{m}:{s:02d}'])

    def money(self):
        r = self.r
        v = r.choice([f'{r.uniform(0, 100):.2f}', f'{r.uniform(100, 99999):,.2f}', f'{r.randint(1, 9999):,}'])
        return r.choice([f'${v}', f'€{v}', f'£{v}', f'{v} €', f'¥{v}', f'USD {v}', f'-${v}', f'({v})', f'{v} EUR'])

    def path(self):
        r = self.r
        parts = [self.r.choice([self.w(True), self.w(), self.name().split()[0], str(r.randint(2000, 2039)),
                                f'{self.w()}-{self.w()}', f'{self.w()}_{r.randint(1, 99)}', '.config', 'AppData',
                                'Program Files', 'node_modules', 'src', 'bin', 'Release', 'x64', 'arm64'])
                 for _ in range(r.randint(1, 6))]
        f = f'{self.r.choice([self.w(), self.w(True), self.w() + "-" + self.w(), "IMG_" + str(r.randint(1000, 9999))])}.{r.choice(EXT)}'
        k = r.randint(0, 9)
        if k <= 4:
            return f'{r.choice("CDEFGZ")}:\\' + '\\'.join(parts + [f])
        if k <= 5:
            return f'\\\\{self.w()}-{r.randint(1, 99)}\\' + '\\'.join(parts + [f])
        if k <= 7:
            return r.choice(['/', '~/', './', '../']) + '/'.join(parts + [f])
        if k <= 8:
            return f'%{r.choice(["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "ProgramData"])}%\\' + '\\'.join(parts)
        return r.choice(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKLM:', 'HKCU:']) + '\\' + '\\'.join(
            [self.w(True) for _ in range(r.randint(2, 5))])

    def url(self):
        r = self.r
        host = r.choice(['', 'www.', 'api.', 'docs.', 'mail.', 'cdn.']) + self.w() + r.choice(['', '-' + self.w()]) + '.' + r.choice(TLD)
        p = '/'.join(r.choice([self.w(), str(r.randint(1, 99999)), f'{self.w()}-{self.w()}', 'v2', 'en-us'])
                     for _ in range(r.randint(0, 4)))
        q = '' if r.random() < 0.6 else '?' + '&'.join(f'{self.w()}={r.choice([self.w(), str(r.randint(0, 9999))])}'
                                                        for _ in range(r.randint(1, 3)))
        k = r.randint(0, 9)
        if k <= 6:
            return f'{r.choice(["https", "http"])}://{host}/{p}{q}'.rstrip('/')
        if k <= 8:
            return f'{self.w()}{r.choice([".", "_", ""])}{self.w()}{r.choice(["", str(r.randint(1, 99))])}@{host}'
        return f'{host}/{p}'

    def numbers(self):
        r = self.r
        k = r.randint(0, 13)
        if k == 0:
            return f'{r.randint(0, 255)}.{r.randint(0, 255)}.{r.randint(0, 255)}.{r.randint(0, 255)}' + r.choice(['', f':{r.randint(1, 65535)}'])
        if k == 1:
            return '0x' + ''.join(r.choice('0123456789ABCDEF') for _ in range(r.choice([2, 4, 8])))
        if k == 2:
            h = lambda n: ''.join(r.choice('0123456789abcdef') for _ in range(n))
            return f'{h(8)}-{h(4)}-{h(4)}-{h(4)}-{h(12)}' if r.random() < 0.5 else h(r.choice([7, 12, 40]))
        if k == 3:
            return f'{r.randint(0, 30)}.{r.randint(0, 40)}.{r.randint(0, 300)}' + r.choice(['', f'-beta.{r.randint(1, 9)}', f'.{r.randint(0, 9999)}'])
        if k == 4:
            return f'+{r.randint(1, 99)} {r.randint(10, 999)} {r.randint(100, 999)} {r.randint(1000, 9999)}' if r.random() < 0.5 else f'({r.randint(200, 999)}) {r.randint(200, 999)}-{r.randint(1000, 9999)}'
        if k == 5:
            return f'{self.num()} {r.choice(UNITS)}'
        if k == 6:
            return self.money()
        if k == 7:
            return f'{self.date()} {self.time()}'
        if k == 8:
            return '  '.join(self.num() for _ in range(r.randint(2, 7)))
        if k == 9:
            return f'{r.randint(1, 999)} of {r.randint(1000, 99999):,}'
        if k == 10:
            return f'#{r.randint(1, 99999)}'
        if k == 11:
            return ''.join(r.choice('0123456789') for _ in range(r.randint(4, 20)))
        if k == 12:
            return f'{r.choice(["Order", "Invoice", "Ref", "Case", "Ticket", "ID"])} {r.choice(["#", "No. ", ""])}{r.choice(["", "INV-", "A"])}{r.randint(1000, 99999999)}'
        return self.date() if r.random() < 0.5 else self.time()

    def ui(self):
        r = self.r
        k = r.randint(0, 15)
        if k == 0:
            return '  '.join(self.w(True) for _ in range(r.randint(3, 8)))
        if k == 1:
            return ' > '.join(self.ws(1, 3) for _ in range(r.randint(2, 4)))
        if k == 2:
            return f'{self.ws(1, 2)} ({r.randint(0, 999)} {self.w()}, {self.num()} {r.choice(UNITS)})'
        if k == 3:
            return f'{self.ws(1, 3)}: {r.choice([self.num(), self.w(), self.date(), self.time(), self.money(), self.name()])}'
        if k == 4:
            return self.r.choice(['OK', 'Cancel', 'Apply', 'Save', 'Save as…', 'Open', 'Close', 'Yes', 'No', 'Retry',
                                  'Next >', '< Back', 'Sign in', 'Sign out', 'Continue', 'Learn more', 'Skip', 'Done',
                                  'Undo', 'Redo', 'Share', 'Print', 'Search', 'Help', 'More…', '✓ Saved', 'Edit',
                                  'Delete', 'Rename', 'Copy', 'Paste', 'Cut', 'Select all', 'Refresh', 'Settings'])
        if k == 5:
            return f'{self.ws(2, 7)}{r.choice(["?", ".", "!", "…", ""])}'
        if k == 6:
            return f'{self.name()} {r.choice(["·", "•", "-", "—", "|"])} {r.choice([self.time(), self.date(), self.w(True)])}'
        if k == 7:
            return f'{r.choice(["Ctrl", "Alt", "Shift", "Win", "Ctrl+Shift", "Ctrl+Alt"])}+{r.choice(list("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") + ["F" + str(i) for i in range(1, 13)] + ["Tab", "Enter", "Esc", "Del", "Space"])}'
        if k == 8:
            return f'{r.choice(["Error", "Warning", "Info", "Failed", "Success", "Note"])}{r.choice([":", " -", ""])} {self.ws(2, 8, False)}{r.choice([".", "", " (code " + str(r.randint(1, 9999)) + ")"])}'
        if k == 9:
            f = f'{self.w()}{r.choice(["-", "_", " "])}{self.w()}.{r.choice(EXT)}'
            return f'{f}{r.choice(["  ", "    "])}{self.num()} {r.choice(["KB", "MB"])}{r.choice(["  ", "    "])}{self.date()}'
        if k == 10:
            return f'{r.randint(1, 100)}% {r.choice(["complete", "done", "used", "free", "battery", "CPU", "of 100"])}'
        if k == 11:
            return f'{self.w(True)} {r.choice(["v", "version "])}{r.randint(0, 20)}.{r.randint(0, 40)}.{r.randint(0, 99)}'
        if k == 12:
            return f'[{r.choice([" ", "x", "✓"])}] {self.ws(1, 5)}'
        if k == 13:
            return f'{r.choice(["•", "-", "*", "→", str(r.randint(1, 20)) + ".", chr(97 + r.randint(0, 6)) + ")"])} {self.ws(2, 9)}'
        if k == 14:
            return f'{self.w(True)} {r.choice(["(", "["])}{r.randint(1, 999)}{r.choice([")", "]"])}'
        return self.w(True) if r.random() < 0.5 else self.ws(1, 3)

    def accented(self):
        r = self.r
        out = []
        for _ in range(r.randint(1, 8)):
            w = self.w(r.random() < 0.3)
            w = ''.join(r.choice(ACCENTS[c]) if c in ACCENTS and r.random() < 0.35 else c for c in w)
            out.append(w)
        if r.random() < 0.3:
            out.insert(r.randint(0, len(out)), self.name())
        s = ' '.join(out)
        return s.replace('ss', 'ß', 1) if r.random() < 0.1 else s

    def typography(self):
        r = self.r
        s = self.ws(1, 6)
        k = r.randint(0, 7)
        if k == 0:
            return f'“{s}”'
        if k == 1:
            return f'‘{s}’ {self.w()}’s'
        if k == 2:
            return f'{s} — {self.ws(1, 4, False)}'
        if k == 3:
            return f'{r.randint(1990, 2039)}–{r.randint(1990, 2039)} {s}'
        if k == 4:
            return f'© {r.randint(1990, 2039)} {self.w(True)}{r.choice(["®", "™", ""])} {s}'
        if k == 5:
            return f'{r.randint(-40, 120)}°{r.choice(["C", "F", ""])} {r.choice(["±", "×", "÷", "≈" if False else "~"])} {r.randint(1, 99)} {s}'
        if k == 6:
            return f'« {s} » {r.choice(["¿", "¡"])}{self.w(True)}{r.choice(["?", "!"])}'
        return ' '.join(r.choice([self.w(), r.choice(TYPO), self.money()]) for _ in range(r.randint(2, 8)))

    def caps(self):
        s = self.ws(1, 7)
        return s.upper() if self.r.random() < 0.6 else ' '.join(x[:1].upper() + x[1:] for x in s.split())

    def soup(self):
        r = self.r
        pools = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', SYMBOLS, TYPO,
                 'Il1|!iíj', 'O0oQDØ', 'rnmwvuMWVU', '.,:;\'"`´^~-_', '{}[]()<>/\\|', CHARSET[95:]]
        weights = [3, 3, 3, 3, 1, 2, 2, 1, 2, 2, 1]
        out = []
        for _ in range(r.randint(1, 9)):
            p = r.choices(pools, weights)[0]
            out.append(''.join(r.choice(p) if r.random() < 0.75 else r.choice(CHARSET[1:95]) for _ in range(r.randint(1, 10))))
        return ' '.join(out)

    def roman(self):
        # Roman numerals among words: most sans faces draw a capital I as their l, so only the words around them tell.
        r = self.r
        n = r.choices(ROMAN, [4, 10, 8, 5, 4, 3, 3, 2, 2, 3, 1, 1, 1, 1, 1])[0]
        k = r.randint(0, 6)
        if k == 0:
            return f'{self.ws(1, 4)} {n}'
        if k == 1:
            return f'{self.w(True)} {n}: {self.ws(1, 5, False)}'
        if k == 2:
            return f'{n}. {self.ws(1, 6)}'
        if k == 3:
            return f'{self.name()} {n}'
        if k == 4:
            return (f'{r.choice(["Part", "Chapter", "Volume", "Level", "Season", "Tier", "Phase", "Act", "Book", "Stage"])} {n}'
                    f'{r.choice(["", " - " + self.ws(1, 4), ": " + self.ws(1, 4)])}')
        if k == 5:
            return f'{self.ws(1, 3)} {n}'.upper()
        return f'{self.ws(1, 3)} {n} {self.ws(1, 3, False)}'

    def pick_prose(self):
        s = self.r.choice(self.prose)
        return s

    def pick_code(self):
        return self.r.choice(self.code)


KINDS = [('prose', 20), ('code', 14), ('ui', 16), ('path', 8), ('url', 6), ('numbers', 11), ('soup', 12),
         ('accented', 4), ('caps', 4), ('typography', 5)]


def generate(repo: Path, count: int, seed: int, kinds=KINDS):
    rnd = random.Random(seed)
    prose, code, words = repo_text(repo, rnd)
    g = Gen(rnd, prose, code, words)
    banned = set()
    for s in check_strings(repo):
        banned |= grams(s)
    make = {'prose': g.pick_prose, 'code': g.pick_code, 'ui': g.ui, 'path': g.path, 'url': g.url, 'numbers': g.numbers,
            'soup': g.soup, 'accented': g.accented, 'caps': g.caps, 'typography': g.typography, 'roman': g.roman}
    names, weights = zip(*kinds)
    seen = set()
    out = []
    while len(out) < count:
        kind = rnd.choices(names, weights)[0]
        s = squash(make[kind]())
        if not s or len(s) > 100 or any(c not in ALLOWED for c in s):
            continue
        if s in seen or (grams(s) & banned):
            continue
        seen.add(s)
        out.append({'text': s, 'kind': kind})
    return out


if __name__ == '__main__':
    repo, count, dest = Path(sys.argv[1]), int(sys.argv[2]), Path(sys.argv[3])
    seed = int(sys.argv[sys.argv.index('--seed') + 1]) if '--seed' in sys.argv else 1
    kinds = [(k, 1) for k in sys.argv[sys.argv.index('--kinds') + 1].split(',')] if '--kinds' in sys.argv else KINDS
    lines = generate(repo, count, seed, kinds)
    dest.write_text(''.join(json.dumps(l, ensure_ascii=False) + '\n' for l in lines), encoding='utf-8')
    print(len(lines), 'lines')
