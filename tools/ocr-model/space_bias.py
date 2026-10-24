"""Chooses how much to raise the space's logit (export.py --space-bias): reads the held-back lines with a checkpoint at
each bias and prints how many come out exactly, and the check's pictures' lines for comparison.

    python space_bias.py <models> <checkpoint.pt> <val dir> <fixtures dir>

The check draws small screen text with narrower spaces than the training lines have, and a space the model is unsure of
loses to the letters either side: at 11 and 12 px most of what the fine-tuned model got wrong was a missing space. The
bias is chosen by the held-back lines alone (the best of BIASES), so the check stays a fair test of it.
"""
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import train  # noqa: E402
from recnet import CHARSET, from_onnx  # noqa: E402
from score import report  # noqa: E402

SPACE = CHARSET.index(' ') + 1
BIASES = (0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3)


def greedy(logits: np.ndarray, bias: float) -> str:
    """The best class at each step, the space's raised by bias; repeats and blanks dropped, as the reader decodes."""
    lg = logits.copy()
    lg[:, SPACE] += bias
    s, prev = [], 0
    for b in lg.argmax(-1):
        if b != prev and b != 0 and b <= len(CHARSET):
            s.append(CHARSET[b - 1])
        prev = b
    return ''.join(s).strip()


@torch.no_grad()
def logits_of(net, xs):
    """Each input's logits, read in batches of one width each so every line has the padding the reader gives it."""
    widths = [train.bucket(x.shape[2]) for x in xs]
    out = [None] * len(xs)
    for W in sorted(set(widths)):
        group = [i for i in range(len(xs)) if widths[i] == W]
        for b in range(0, len(group), 32):
            chunk = group[b:b + 32]
            x = np.zeros((len(chunk), 3, train.HEIGHT, W), np.float32)
            for k, i in enumerate(chunk):
                x[k, :, :, :xs[i].shape[2]] = xs[i]
            y = net(torch.from_numpy(x)).numpy()
            for k, i in enumerate(chunk):
                out[i] = y[k]
    return out


def main():
    models, ckpt, val_dir, fx = (Path(a) for a in sys.argv[1:5])
    torch.set_num_threads(6)
    saved = torch.load(ckpt, map_location='cpu')
    net = from_onnx(models / 'v6-tiny-rec', stride=saved.get('stride', 8))
    net.load_state_dict(saved['model'])
    net.eval()
    val = train.Lines([val_dir], False, saved.get('stride', 8))
    items = [val[i] for i in range(len(val))]
    vlog = logits_of(net, [x for x, _, _ in items])
    crops = train.FixtureCrops(fx, models)
    flat = [(p, r, c) for p, (_, rows) in enumerate(crops.pics) for r, row in enumerate(rows) for c in row]
    flog = logits_of(net, [train.to_input(c) for *_, c in flat])
    best = None
    for bias in BIASES:
        exact = sum(greedy(lg, bias) == val.items[i]['text'] for lg, (_, _, i) in zip(vlog, items)) / len(items)
        rows = {}
        for (p, r, _), lg in zip(flat, flog):
            rows.setdefault((p, r), []).append(greedy(lg, bias))
        texts = {}
        for p, (f, prow) in enumerate(crops.pics):
            lines = [' '.join(w for w in rows.get((p, r), []) if w.strip()) for r in range(len(prow))]
            texts[f] = '\n'.join(l for l in lines if l)
        groups, _ = report(fx, texts, 'fixtures', quiet=True)
        print(f"bias {bias}: held-back lines {exact:.4f}; the check's lines {groups['all']['linesOk']}/{groups['all']['lines']}", flush=True)
        if best is None or exact > best[1]:
            best = (bias, exact)
    print(f'best on the held-back lines: --space-bias {best[0]}')


if __name__ == '__main__':
    main()
