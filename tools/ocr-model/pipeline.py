"""A PP-OCR-style reader on ONNX Runtime: DB text detection, line crops, CTC recognition. For trying candidates on
the check's pictures (run.py). Horizontal text only (screens and pages), axis-aligned boxes."""
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import yaml
from PIL import Image
from scipy import ndimage

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def session(path, providers=None, opts=None):
    o = opts or ort.SessionOptions()
    return ort.InferenceSession(str(path), sess_options=o, providers=providers or ['CPUExecutionProvider'])


class Det:
    def __init__(self, model_dir, thresh=0.3, box_thresh=0.5, unclip=1.6, limit=None, sess=None):
        self.s = sess or session(Path(model_dir) / 'inference.onnx')
        self.thresh, self.box_thresh, self.unclip, self.limit = thresh, box_thresh, unclip, limit

    def prob(self, bgr: np.ndarray, scale: float):
        h, w = bgr.shape[:2]
        nh, nw = max(32, int(round(h * scale / 32)) * 32), max(32, int(round(w * scale / 32)) * 32)
        im = np.asarray(Image.fromarray(bgr).resize((nw, nh), Image.BILINEAR), np.float32) / 255.0 if (nh, nw) != (h, w) else bgr.astype(np.float32) / 255.0
        x = ((im - MEAN) / STD).transpose(2, 0, 1)[None]
        p = self.s.run(None, {self.s.get_inputs()[0].name: x})[0][0, 0]
        return p, nw / w, nh / h

    def boxes(self, bgr: np.ndarray, scale=1.0):
        p, sx, sy = self.prob(bgr, scale)
        lab, n = ndimage.label(p > self.thresh)
        out = []
        for i, sl in enumerate(ndimage.find_objects(lab)):
            if sl is None:
                continue
            ys, xs = sl
            bh, bw = ys.stop - ys.start, xs.stop - xs.start
            if min(bh, bw) < 3:
                continue
            region = lab[sl] == i + 1
            if p[sl][region].mean() < self.box_thresh:
                continue
            d = bw * bh * self.unclip / (2 * (bw + bh))
            x0, y0, x1, y1 = (xs.start - d) / sx, (ys.start - d) / sy, (xs.stop + d) / sx, (ys.stop + d) / sy
            H, W = bgr.shape[:2]
            out.append((max(0, int(x0)), max(0, int(y0)), min(W, int(np.ceil(x1))), min(H, int(np.ceil(y1)))))
        return out


class Rec:
    def __init__(self, model_dir, sess=None, height=48):
        d = Path(model_dir)
        self.s = sess or session(d / 'inference.onnx')
        cfg = yaml.safe_load((d / 'inference.yml').read_text(encoding='utf-8'))
        chars = cfg['PostProcess']['character_dict']
        self.chars = [''] + [str(c) for c in chars] + [' ']
        self.height = height

    def prep(self, bgr: np.ndarray, width=None):
        h, w = bgr.shape[:2]
        nw = max(8, int(np.ceil(self.height * w / max(1, h))))
        im = np.asarray(Image.fromarray(bgr).resize((nw, self.height), Image.BILINEAR), np.float32) / 255.0
        x = ((im - 0.5) / 0.5).transpose(2, 0, 1)
        W = width or int(np.ceil(nw / 8) * 8)
        if nw > W:
            x = np.asarray(Image.fromarray(bgr).resize((W, self.height), Image.BILINEAR), np.float32).transpose(2, 0, 1) / 127.5 - 1
            nw = W
        out = np.zeros((3, self.height, W), np.float32)
        out[:, :, :nw] = x
        return out

    def decode(self, probs: np.ndarray):
        idx = probs.argmax(-1)
        s, prev = [], 0
        for k in idx:
            if k != prev and k != 0:
                s.append(self.chars[k] if k < len(self.chars) else '')
            prev = k
        return ''.join(s)

    def read(self, crops):
        out = []
        for c in crops:
            x = self.prep(c)[None]
            p = self.s.run(None, {self.s.get_inputs()[0].name: x})[0][0]
            out.append(self.decode(p))
        return out


def lines_of(boxes):
    """Boxes grouped into rows by vertical overlap, each row left to right, rows top to bottom."""
    rows = []
    for b in sorted(boxes, key=lambda b: (b[1] + b[3]) / 2):
        cy = (b[1] + b[3]) / 2
        for r in rows:
            ry0, ry1 = min(x[1] for x in r), max(x[3] for x in r)
            if ry0 <= cy <= ry1 and min(b[3], ry1) - max(b[1], ry0) > 0.5 * min(b[3] - b[1], ry1 - ry0):
                r.append(b)
                break
        else:
            rows.append([b])
    return [sorted(r) for r in sorted(rows, key=lambda r: min(x[1] for x in r))]


class Reader:
    def __init__(self, det: Det, rec: Rec, det_scale=1.0, pad=0):
        self.det, self.rec, self.det_scale, self.pad = det, rec, det_scale, pad

    def read(self, path):
        rgb = np.asarray(Image.open(path).convert('RGB'))
        bgr = rgb[:, :, ::-1].copy()
        t = time.perf_counter()
        boxes = self.det.boxes(bgr, self.det_scale)
        rows = lines_of(boxes)
        texts = []
        for r in rows:
            crops = [bgr[b[1]:b[3], b[0]:b[2]] for b in r]
            words = [w for w in self.rec.read(crops) if w.strip()]
            if words:
                texts.append(' '.join(words))
        return '\n'.join(texts), (time.perf_counter() - t) * 1000, len(boxes)
