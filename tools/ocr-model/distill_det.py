"""Teaches a detector with its GELUs swapped (gelu_free.py) to draw the probability map its teacher draws: the reader's
detector, PP-OCRv6 tiny's as published. No boxes are labelled; the teacher's map is the answer.

    python distill_det.py <teacher det.onnx> <screens dir> <val screens dir> <out dir> [--act relu|hardswish]
        [--steps N] [--lr X] [--batch N] [--every N] [--threads N] [--workers N] [--resume <out>/last.pt]

The screens are screens.py's. Each step reads tiles as the reader cuts them (kit/node/ocr-npu.cs, Reader.Tile: 640 by
640, a picture smaller than a tile left 0 beyond it), now and then a little blurred, compressed or faded. The loss is
the binary cross-entropy of the student's map against the teacher's. Every --every steps it scores the held-back
screens: how many of the teacher's boxes (pipeline.Det's, thresholds as the reader's) the student finds, and how many
it adds, by the boxes' overlap; best.pt is the step whose boxes agree most. Writes <out>\\last.pt, <out>\\best.pt and
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
from gelu_free import load  # noqa: E402
from pipeline import MEAN, STD, Det  # noqa: E402

TILE = 640


def to_input(bgr: np.ndarray) -> np.ndarray:
    """A tile as the detector takes it (pipeline.Det.prob at scale 1): 0..1, less the mean, over the deviation, CHW;
    where the picture ends before the tile does, 0."""
    x = np.zeros((3, TILE, TILE), np.float32)
    h, w = bgr.shape[:2]
    x[:, :h, :w] = ((bgr.astype(np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1)
    return x


class Tiles(torch.utils.data.Dataset):
    def __init__(self, root: Path, train: bool):
        self.files = sorted(Path(root).glob('*.png'))
        self.train = train
        self.rnd = random.Random(0)

    def __len__(self):
        return len(self.files)

    def __getitem__(self, i):
        r = self.rnd if self.train else random.Random(i)
        im = Image.open(self.files[i]).convert('RGB')
        if self.train and r.random() < 0.1:
            # A picture smaller than a tile, as a dialog or a cut-out is: the rest of the tile reads 0.
            w, h = r.randint(160, TILE), r.randint(48, TILE)
        else:
            w, h = TILE, TILE
        w, h = min(w, im.width), min(h, im.height)
        x0, y0 = r.randint(0, im.width - w), r.randint(0, im.height - h)
        im = im.crop((x0, y0, x0 + w, y0 + h))
        if self.train:
            if r.random() < 0.05:
                im = im.filter(ImageFilter.GaussianBlur(r.uniform(0.3, 0.8)))
            if r.random() < 0.1:
                b = io.BytesIO()
                im.save(b, 'JPEG', quality=r.randint(40, 92))
                im = Image.open(io.BytesIO(b.getvalue())).convert('RGB')
            if r.random() < 0.1:
                a = np.asarray(im, np.float32)
                k = r.uniform(0.6, 1.0)
                im = Image.fromarray(np.clip(a * k + a.mean() * (1 - k), 0, 255).astype(np.uint8))
        return torch.from_numpy(to_input(np.asarray(im)[:, :, ::-1]))


def worker_init(k):
    torch.set_num_threads(1)
    info = torch.utils.data.get_worker_info()
    info.dataset.rnd = random.Random(info.seed)


def boxes_of(p: np.ndarray):
    """The boxes the reader would take from a probability map (pipeline.Det's thresholds)."""
    d = Det.__new__(Det)
    d.thresh, d.box_thresh, d.unclip, d.limit = 0.3, 0.5, 1.6, None
    d.prob = lambda bgr, scale: (p, 1.0, 1.0)
    return d.boxes(np.zeros((p.shape[0], p.shape[1], 3), np.uint8))


def iou(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


@torch.no_grad()
def score(student, teacher, val: Tiles, limit: int):
    student.eval()
    found = want = extra = 0
    pix = agree = 0
    for i in range(min(limit, len(val))):
        x = val[i][None]
        pt = teacher(x)[0, 0].numpy()
        ps = torch.sigmoid(student(x))[0, 0].numpy()
        agree += int(((pt > 0.3) == (ps > 0.3)).sum())
        pix += pt.size
        bt, bs = boxes_of(pt), boxes_of(ps)
        want += len(bt)
        found += sum(1 for b in bt if any(iou(b, c) >= 0.8 for c in bs))
        extra += sum(1 for c in bs if not any(iou(b, c) >= 0.5 for b in bt))
    student.train()
    return dict(found=found / max(1, want), extra=extra / max(1, want), boxes=want, pixels=agree / max(1, pix))


def main():
    teacher_path, train_dir, val_dir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
    arg = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
    act, steps, lr, batch = arg('--act', 'relu'), arg('--steps', 4000), arg('--lr', 3e-4), arg('--batch', 8)
    every, resume, val_n = arg('--every', 250), arg('--resume', ''), arg('--val', 200)
    out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(0)
    torch.set_num_threads(arg('--threads', 5))
    teacher = load(teacher_path).eval()
    for p in teacher.parameters():
        p.requires_grad_(False)
    student = load(teacher_path, act, logits=True)
    first = 0
    if resume:
        saved = torch.load(resume, map_location='cpu')
        student.load_state_dict(saved['model'])
        first = saved['step']
    student.train()
    train, val = Tiles(train_dir, True), Tiles(val_dir, False)
    loader = torch.utils.data.DataLoader(train, batch_size=batch, shuffle=True, num_workers=arg('--workers', 3),
                                         worker_init_fn=worker_init, persistent_workers=True, prefetch_factor=4, drop_last=True)
    opt = torch.optim.AdamW(student.parameters(), lr=lr, weight_decay=1e-4)
    warm = 100
    cosine = lambda s: 0.5 * (1 + math.cos(math.pi * min(1.0, s / steps)))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * cosine(s + first))
    log = (out / 'log.jsonl').open('a', encoding='utf-8')
    keep = lambda step, name: torch.save(dict(model=student.state_dict(), step=step, onnx=str(teacher_path.resolve()), act=act), out / name)

    def evaluate(step):
        s = score(student, teacher, val, val_n)
        log.write(json.dumps(dict(step=step, val=s, t=time.time())) + '\n')
        log.flush()
        print(f"step {step}: teacher's boxes found {s['found']:.4f}, added {s['extra']:.4f} (of {s['boxes']}); pixels {s['pixels']:.5f}", flush=True)
        return s['found'] - s['extra']

    best = max((json.loads(l)['val']['found'] - json.loads(l)['val']['extra'] for l in (out / 'log.jsonl').read_text(encoding='utf-8').splitlines() if l),
               default=-1.0) if resume else evaluate(0)
    if not resume:
        keep(0, 'best.pt')
    step, t0, run_loss = first, time.time(), None
    while step < steps:
        for x in loader:
            with torch.no_grad():
                want = teacher(x)
            loss = F.binary_cross_entropy_with_logits(student(x), want)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(student.parameters(), 5.0)
            opt.step()
            sched.step()
            step += 1
            run_loss = loss.item() if run_loss is None else 0.95 * run_loss + 0.05 * loss.item()
            if step % 25 == 0:
                print(f'step {step} loss {run_loss:.5f} lr {sched.get_last_lr()[0]:.2e} {(step - first) * batch / (time.time() - t0):.1f} tiles/s', flush=True)
            if step % every == 0 or step == steps:
                s = evaluate(step)
                keep(step, 'last.pt')
                if s > best:
                    best = s
                    keep(step, 'best.pt')
            if step >= steps:
                break


if __name__ == '__main__':
    main()
