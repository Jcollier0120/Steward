"""Fine-tunes the recognizer on the drawn lines (draw.py), checking it on held-back drawn lines and on the check's
pictures (fixtures.ts) as it goes.

    python train.py <models> <train dir> <val dir> <fixtures dir> <out dir> [--steps N] [--lr X] [--from ckpt.pt]

<models> has v6-tiny-rec and v6-tiny-det (fetch.py). Each crop is cut from its drawing with random room around the ink,
as the detector's boxes leave it (0 to 0.6 of the ink's height each side), sometimes blurred, compressed or faded, then
made 48 pixels high as the reader makes it, and padded with grey to the width the reader's graph for it takes (BUCKETS),
as the reader pads it: the model's squeeze-and-excite blocks average over the padding too, so it must be taught with
the padding it will read with. Writes <out>\\last.pt, <out>\\best.pt (by exact lines on the val set) and
<out>\\log.jsonl.
"""
import io
import json
import math
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from recnet import CHARSET, decode, from_onnx  # noqa: E402

HEIGHT = 48
MAX_W = 2048
# The widths the reader's recognizer graphs take (kit/node/ocr-npu.cs, Reader.Buckets): each line is padded to the
# narrowest that holds it.
BUCKETS = (128, 256, 384, 512, 768, 1024, 1536, 2048)
INDEX = {c: i + 1 for i, c in enumerate(CHARSET)}
BENCH = "the bench's 25"


def to_input(bgr: np.ndarray, width=None) -> np.ndarray:
    """A crop as the recognizer takes it: 48 high, width in proportion (a multiple of 8), scaled to -1..1, CHW."""
    h, w = bgr.shape[:2]
    nw = min(MAX_W, max(8, int(math.ceil(HEIGHT * w / max(1, h)))))
    im = np.asarray(Image.fromarray(bgr).resize((nw, HEIGHT), Image.BILINEAR), np.float32)
    x = (im / 127.5 - 1.0).transpose(2, 0, 1)
    W = width or int(math.ceil(nw / 8) * 8)
    out = np.zeros((3, HEIGHT, W), np.float32)
    out[:, :, :min(nw, W)] = x[:, :, :W]
    return out


def bucket(w: int) -> int:
    for b in BUCKETS:
        if w <= b:
            return b
    return int(math.ceil(w / 8) * 8)


def needed_steps(ids):
    return len(ids) + sum(1 for a, b in zip(ids, ids[1:]) if a == b)


class Lines(torch.utils.data.Dataset):
    def __init__(self, root: Path, train: bool):
        self.root, self.train = Path(root), train
        self.items = [json.loads(l) for l in (self.root / 'labels.jsonl').read_text(encoding='utf-8').splitlines() if l]
        self.rnd = random.Random()

    def __len__(self):
        return len(self.items)

    def approx_width(self, i):
        x0, y0, x1, y1 = self.items[i]['ink']
        h = max(1, y1 - y0)
        return HEIGHT * (x1 - x0 + 0.6 * h) / (1.5 * h)

    def __getitem__(self, i):
        it = self.items[i]
        r = self.rnd if self.train else random.Random(i)
        im = Image.open(self.root / 'crops' / it['f']).convert('RGB')
        x0, y0, x1, y1 = it['ink']
        h = y1 - y0
        if self.train:
            m = [r.uniform(0, 0.6), r.uniform(0.05, 0.6), r.uniform(0, 0.6), r.uniform(-0.03, 0.6)]
        else:
            m = [0.22, 0.29, 0.21, 0.2]  # the detector's medians on the check's pictures
        box = (max(0, round(x0 - m[0] * h)), max(0, round(y0 - m[1] * h)), min(im.width, round(x1 + m[2] * h)),
               min(im.height, round(y1 + m[3] * h)))
        im = im.crop(box)
        if self.train:
            if r.random() < 0.15:
                f = r.uniform(0.55, 0.9)
                im = im.resize((max(1, round(im.width * f)), max(1, round(im.height * f))), Image.BILINEAR)
            if r.random() < 0.05:
                im = im.filter(ImageFilter.GaussianBlur(r.uniform(0.3, 0.8)))
            if r.random() < 0.1:
                b = io.BytesIO()
                im.save(b, 'JPEG', quality=r.randint(35, 90))
                im = Image.open(io.BytesIO(b.getvalue())).convert('RGB')
            if r.random() < 0.1:
                a = np.asarray(im, np.float32)
                k = r.uniform(0.55, 1.0)
                im = Image.fromarray(np.clip(a * k + a.mean() * (1 - k), 0, 255).astype(np.uint8))
        bgr = np.asarray(im)[:, :, ::-1].copy()
        x = to_input(bgr)
        ids = [INDEX[c] for c in it['text']]
        T = x.shape[2] // 8
        if needed_steps(ids) > T:
            # Too narrow for its characters at this width: widened to fit, rather than taught an answer it can't give.
            W = int(math.ceil(needed_steps(ids) * 1.15)) * 8
            im2 = Image.fromarray(bgr).resize((W, HEIGHT), Image.BILINEAR)
            x = (np.asarray(im2, np.float32) / 127.5 - 1.0).transpose(2, 0, 1)
        return x, ids, i


def batches(ds: Lines, budget: int, rnd: random.Random):
    """Indices in batches of like widths, each about `budget` columns wide in all."""
    idx = list(range(len(ds)))
    rnd.shuffle(idx)
    out = []
    for g in range(0, len(idx), 4096):
        group = sorted(idx[g:g + 4096], key=ds.approx_width)
        cur, widest = [], 0
        for i in group:
            w = ds.approx_width(i)
            if cur and max(widest, w) * (len(cur) + 1) > budget:
                out.append(cur)
                cur, widest = [], 0
            cur.append(i)
            widest = max(widest, w)
        if cur:
            out.append(cur)
    rnd.shuffle(out)
    return out


def collate(items):
    W = bucket(max(x.shape[2] for x, _, _ in items))
    xs = np.zeros((len(items), 3, HEIGHT, W), np.float32)
    for k, (x, _, _) in enumerate(items):
        xs[k, :, :, :x.shape[2]] = x
    targets = torch.tensor([c for _, ids, _ in items for c in ids], dtype=torch.long)
    lengths = torch.tensor([len(ids) for _, ids, _ in items], dtype=torch.long)
    return torch.from_numpy(xs), targets, lengths, [i for _, _, i in items]


class Batches(torch.utils.data.Sampler):
    def __init__(self, ds, budget, seed):
        self.ds, self.budget, self.seed, self.epoch = ds, budget, seed, 0

    def __iter__(self):
        self.epoch += 1
        return iter(batches(self.ds, self.budget, random.Random(self.seed * 1000 + self.epoch)))

    def __len__(self):
        return len(batches(self.ds, self.budget, random.Random(0)))


def worker_init(k):
    torch.set_num_threads(1)
    info = torch.utils.data.get_worker_info()
    info.dataset.rnd = random.Random(info.seed)


@torch.no_grad()
def run_val(net, ds: Lines, limit=None):
    net.eval()
    n = len(ds) if limit is None else min(limit, len(ds))
    order = sorted(range(n), key=ds.approx_width)
    ok = chars = edits = 0
    misses = []
    # Read in batches of one width each, so every line has the padding the reader gives it.
    chunks, cur = [], []
    for i in order:
        item = ds[i]
        if cur and (len(cur) == 32 or bucket(item[0].shape[2]) != bucket(cur[0][0].shape[2])):
            chunks.append(cur)
            cur = []
        cur.append(item)
    if cur:
        chunks.append(cur)
    for chunk in chunks:
        xs, _, _, ids = collate(chunk)
        for i, got in zip(ids, decode(net(xs))):
            want = ds.items[i]['text']
            ok += got == want
            chars += len(want)
            edits += lev(want, got)
            if got != want and len(misses) < 400:
                misses.append((ds.items[i]['kind'], want, got))
    net.train()
    return dict(exact=ok / n, chars=1 - edits / max(1, chars), n=n), misses


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[-1]


class FixtureCrops:
    """The check's pictures cut into the detector's rows once, so each check of the recognizer costs only reading."""

    def __init__(self, fx: Path, models: Path):
        from pipeline import Det, lines_of
        self.fx = fx
        det = Det(models / 'v6-tiny-det')
        truth = json.loads((fx / 'truth.json').read_text(encoding='utf-8-sig'))
        self.pics = []
        for t in truth:
            if t['group'] == 'pdf scan':
                continue
            bgr = np.asarray(Image.open(fx / t['file']).convert('RGB'))[:, :, ::-1].copy()
            rows = lines_of(det.boxes(bgr))
            self.pics.append((t['file'], [[bgr[b[1]:b[3], b[0]:b[2]] for b in r] for r in rows]))

    @torch.no_grad()
    def read(self, net):
        from score import report
        net.eval()
        flat = [(p, r, k, c) for p, (_, rows) in enumerate(self.pics) for r, row in enumerate(rows) for k, c in enumerate(row)]
        xs = [to_input(c) for *_, c in flat]
        got = [''] * len(xs)
        widths = [bucket(x.shape[2]) for x in xs]
        chunks = []
        for W in sorted(set(widths)):
            group = [i for i in range(len(xs)) if widths[i] == W]
            chunks += [(W, group[b:b + 32]) for b in range(0, len(group), 32)]
        for W, chunk in chunks:
            x = np.zeros((len(chunk), 3, HEIGHT, W), np.float32)
            for k, i in enumerate(chunk):
                x[k, :, :, :xs[i].shape[2]] = xs[i]
            for i, s in zip(chunk, decode(net(torch.from_numpy(x)))):
                got[i] = s
        texts = {}
        rows = {}
        for (p, r, k, _), s in zip(flat, got):
            rows.setdefault((p, r), []).append(s)
        for p, (f, prow) in enumerate(self.pics):
            lines = [' '.join(w for w in rows.get((p, r), []) if w.strip()) for r in range(len(prow))]
            texts[f] = '\n'.join(l for l in lines if l)
        net.train()
        groups, _ = report(self.fx, texts, 'fixtures', quiet=True)
        return {g: c['linesOk'] / c['lines'] for g, c in groups.items()}, texts


def main():
    models, train_dir, val_dir, fx, out = (Path(a).resolve() for a in sys.argv[1:6])
    arg = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
    steps, lr, budget, every = arg('--steps', 20000), arg('--lr', 5e-4), arg('--budget', 12000), arg('--every', 1000)
    start = arg('--from', '')
    out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(0)
    torch.set_num_threads(arg('--threads', 15))
    net = from_onnx(models / 'v6-tiny-rec')
    if start:
        net.load_state_dict(torch.load(start, map_location='cpu')['model'])
    net.train()
    train, val = Lines(train_dir, True), Lines(val_dir, False)
    fixtures = FixtureCrops(fx, models)
    loader = torch.utils.data.DataLoader(train, batch_sampler=Batches(train, budget, 1), collate_fn=collate,
                                         num_workers=arg('--workers', 3), worker_init_fn=worker_init,
                                         persistent_workers=True, prefetch_factor=4)
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=1e-4)
    warm = 300
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / steps))))
    log = (out / 'log.jsonl').open('a', encoding='utf-8')

    def evaluate(step):
        v, misses = run_val(net, val)
        f, _ = fixtures.read(net)
        rec = dict(step=step, val=v, fixtures=f, t=time.time())
        log.write(json.dumps(rec) + '\n')
        log.flush()
        print(f"step {step}: val exact {v['exact']:.4f} chars {v['chars']:.4f} | bench's 25 {f.get(BENCH, 0):.4f} all {f['all']:.4f}", flush=True)
        (out / 'misses.json').write_text(json.dumps(misses, ensure_ascii=False, indent=0), encoding='utf-8')
        return v['exact']

    best = evaluate(0) if not start else -1
    torch.save(dict(model=net.state_dict(), step=0), out / 'best.pt')
    step, seen, t0, run_loss = 0, 0, time.time(), None
    while step < steps:
        for xs, targets, lengths, _ in loader:
            logits = net(xs)
            lp = logits.log_softmax(-1).permute(1, 0, 2)
            T = torch.full((xs.shape[0],), lp.shape[0], dtype=torch.long)
            loss = F.ctc_loss(lp, targets, T, lengths, blank=0, zero_infinity=True)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step()
            sched.step()
            step += 1
            seen += xs.shape[0]
            run_loss = loss.item() if run_loss is None else 0.98 * run_loss + 0.02 * loss.item()
            if step % 100 == 0:
                print(f'step {step} loss {run_loss:.4f} lr {sched.get_last_lr()[0]:.2e} {seen / (time.time() - t0):.0f} lines/s', flush=True)
            if step % every == 0 or step == steps:
                score = evaluate(step)
                torch.save(dict(model=net.state_dict(), step=step), out / 'last.pt')
                if score > best:
                    best = score
                    torch.save(dict(model=net.state_dict(), step=step), out / 'best.pt')
            if step >= steps:
                break


if __name__ == '__main__':
    main()
