"""Fold a LoRA add-on into its base GGUF: a merged model, for a server that takes no add-on (FastFlowLM, AMD's NPU).

Each weight the add-on adapts becomes W + scale * (alpha / r) * B @ A, W dequantized from the base, as llama.cpp
applies it at run time (llama-adapter.cpp: alpha / rank, rank being lora_b's first dimension). It is written in
--type: Q4_1 by default, which AMD's q4nx converter packs as it is; F32 for a check against llama-server running the
base with the add-on itself (the two should answer alike). Every other tensor and all the metadata are copied byte
for byte. `--scale 0` writes the adapted weights back without the add-on, requantized the same way: the floor of what
requantizing alone changes.

    python -I -X utf8 merge_lora.py --base <base GGUF> --lora <add-on GGUF> --gguf-py <llama.cpp>/gguf-py
        --out <merged GGUF> [--type Q4_1] [--scale 1]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', type=Path, required=True, help='the base model GGUF')
    ap.add_argument('--lora', type=Path, required=True, help="the add-on, as llama.cpp's convert_lora_to_gguf.py wrote it")
    ap.add_argument('--gguf-py', type=Path, required=True, help="the matching llama.cpp's gguf-py folder")
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--type', default='Q4_1', help='the adapted weights\' type: Q4_1, Q4_0, Q8_0, BF16, F16 or F32')
    ap.add_argument('--scale', type=float, default=1.0, help="the add-on's scale, as a request's lora scale")
    a = ap.parse_args()

    sys.path.insert(0, str(a.gguf_py))
    import numpy as np
    import gguf
    from gguf.quants import dequantize, quantize

    qtype = gguf.GGMLQuantizationType[a.type]
    base = gguf.GGUFReader(a.base)
    lora = gguf.GGUFReader(a.lora)
    alpha = float(lora.fields['adapter.lora.alpha'].contents())
    pairs: dict[str, dict[str, np.ndarray]] = {}
    for t in lora.tensors:
        stem, _, part = t.name.rpartition('.lora_')
        pairs.setdefault(stem, {})[part] = np.asarray(t.data, dtype=np.float32)
    names = {t.name for t in base.tensors}
    missing = sorted(set(pairs) - names)
    if missing:
        raise SystemExit(f'the add-on adapts weights the base lacks: {missing[:5]}')

    arch = base.fields['general.architecture'].contents()
    w = gguf.GGUFWriter(a.out, arch)
    for field in base.fields.values():
        if field.name == 'general.architecture' or field.name.startswith('GGUF.'):
            continue
        val_type = field.types[0]
        sub_type = field.types[-1] if val_type == gguf.GGUFValueType.ARRAY else None
        w.add_key_value(field.name, field.contents(), val_type, sub_type=sub_type)

    merged: dict[str, tuple[np.ndarray, gguf.GGMLQuantizationType]] = {}
    change = []
    for t in base.tensors:
        p = pairs.get(t.name)
        if p is None:
            continue
        A, B = p['a'], p['b']            # A: (r, n_in), B: (n_out, r), as numpy reads llama.cpp's ne order
        r = B.shape[1]
        W = dequantize(t.data, t.tensor_type).astype(np.float32)
        dW = (a.scale * alpha / r) * (B @ A)
        if dW.shape != W.shape:
            raise SystemExit(f'{t.name}: the add-on is {dW.shape}, the weight {W.shape}')
        change.append(float(np.linalg.norm(dW) / max(np.linalg.norm(W), 1e-12)))
        out = W + dW
        data = out if qtype == gguf.GGMLQuantizationType.F32 else quantize(out, qtype)
        merged[t.name] = (data, qtype)

    for t in base.tensors:
        if t.name in merged:
            data, ty = merged[t.name]
            w.add_tensor_info(t.name, data.shape, data.dtype, data.nbytes, ty)
        else:
            w.add_tensor_info(t.name, t.data.shape, t.data.dtype, t.data.nbytes, t.tensor_type)
    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_ti_data_to_file()
    for t in base.tensors:
        w.write_tensor_data(merged[t.name][0] if t.name in merged else t.data, tensor_endianess=base.endianess)
    w.close()
    print(f'{len(merged)} weights merged at scale {a.scale:g} (alpha {alpha:g}), each changed by '
          f'{(sum(change) / len(change)) if change else 0:.1%} of its size on average, written as {a.type} -> {a.out}')


if __name__ == '__main__':
    main()
