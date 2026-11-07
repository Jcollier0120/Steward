"""A throwaway LoRA add-on for a 2B model's language part, in Hugging Face PEFT's layout.

Two models: Qwen3-VL-2B-Instruct (the Snapdragon and Intel NPUs' chat and vision model) and Qwen3.5-2B (AMD's: the
model FastFlowLM runs on its NPU), told apart by the config's model_type.
- Qwen3-VL-2B: the q, k, v and o projections of every layer.
- Qwen3.5-2B: 6 of its 24 layers are full attention, with q (its output gate included), k, v and o; the other 18 are
  linear attention (Gated DeltaNet), with a qkv and an out projection, which are adapted too (`--attention-only`
  leaves them out).

Nothing is trained: A and B are seeded random numbers, and B is scaled so that each add-on's change to its weight,
(alpha / r) * B @ A, is a set fraction (--strength) of that weight's own size (Frobenius norms), read from the base
GGUF the add-on will run on. That is enough to test where an add-on runs and what it costs; a trained one has the
same shapes, so the same ops.

    python -I -X utf8 make_lora.py <out folder> --config <Qwen's config.json> --base-gguf <the 2B's GGUF>
        --gguf-py <llama.cpp>/gguf-py [--rank 16] [--strength 0.05] [--seed 1] [--attention-only]

Then convert it with the matching llama.cpp's convert_lora_to_gguf.py (README.md beside this file).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Each adapted projection: its module under the layer, its PEFT target name, and its GGUF tensor.
FULL_ATTENTION = (
    ('self_attn.q_proj', 'q_proj', 'attn_q'),
    ('self_attn.k_proj', 'k_proj', 'attn_k'),
    ('self_attn.v_proj', 'v_proj', 'attn_v'),
    ('self_attn.o_proj', 'o_proj', 'attn_output'),
)
LINEAR_ATTENTION = (
    ('linear_attn.in_proj_qkv', 'in_proj_qkv', 'attn_qkv'),
    ('linear_attn.out_proj', 'out_proj', 'ssm_out'),
)
BASE_NAME = {'qwen3_vl': 'Qwen/Qwen3-VL-2B-Instruct', 'qwen3_5': 'Qwen/Qwen3.5-2B'}


def projections(cfg: dict, attention_only: bool) -> list[tuple]:
    """(layer, module, target, GGUF name) for every projection the add-on adapts, in the order it draws them."""
    kind = cfg.get('model_type')
    t = cfg['text_config']
    if kind == 'qwen3_5':
        types = t['layer_types']
        return [(il, *p) for il, ty in enumerate(types)
                for p in (FULL_ATTENTION if ty == 'full_attention' else () if attention_only else LINEAR_ATTENTION)]
    if kind == 'qwen3_vl':
        return [(il, *p) for il in range(t['num_hidden_layers']) for p in FULL_ATTENTION]
    raise SystemExit(f"model_type {kind!r}: this maker knows qwen3_vl and qwen3_5")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('out', type=Path)
    ap.add_argument('--config', type=Path, required=True, help="the model's config.json, from Qwen's repository")
    ap.add_argument('--base-gguf', type=Path, required=True, help='the base GGUF, to size each change against')
    ap.add_argument('--gguf-py', type=Path, required=True, help="the matching llama.cpp's gguf-py folder")
    ap.add_argument('--rank', type=int, default=16)
    ap.add_argument('--alpha', type=float, default=None, help='default: twice the rank')
    ap.add_argument('--strength', type=float, default=0.05, help="each change's size as a fraction of its weight's")
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--attention-only', action='store_true', help="Qwen3.5: leave the linear-attention layers alone")
    a = ap.parse_args()

    sys.path.insert(0, str(a.gguf_py))
    import numpy as np
    import torch
    from gguf import GGUFReader
    from gguf.quants import dequantize
    from safetensors.torch import save_file

    cfg = json.loads(a.config.read_text(encoding='utf-8'))
    todo = projections(cfg, a.attention_only)
    r = a.rank
    alpha = a.alpha if a.alpha is not None else 2.0 * r

    reader = GGUFReader(a.base_gguf)
    base = {x.name: x for x in reader.tensors}

    def weight_of(il: int, gguf_name: str) -> np.ndarray:
        x = base[f'blk.{il}.{gguf_name}.weight']
        return dequantize(x.data, x.tensor_type).astype(np.float32)

    g = torch.Generator().manual_seed(a.seed)
    tensors: dict[str, torch.Tensor] = {}
    sizes: list[float] = []
    for il, module, _target, gguf_name in todo:
        w = weight_of(il, gguf_name)
        out_f, in_f = w.shape
        A = torch.randn(r, in_f, generator=g) / in_f ** 0.5
        B = torch.randn(out_f, r, generator=g)
        delta = (alpha / r) * torch.linalg.matrix_norm(B @ A).item()
        want = a.strength * float(np.linalg.norm(w))
        B *= want / delta
        sizes.append(want)
        key = f'base_model.model.model.language_model.layers.{il}.{module}'
        tensors[f'{key}.lora_A.weight'] = A.contiguous()
        tensors[f'{key}.lora_B.weight'] = B.contiguous()

    a.out.mkdir(parents=True, exist_ok=True)
    save_file(tensors, str(a.out / 'adapter_model.safetensors'))
    (a.out / 'adapter_config.json').write_text(json.dumps({
        'peft_type': 'LORA',
        'task_type': 'CAUSAL_LM',
        'base_model_name_or_path': BASE_NAME[cfg['model_type']],
        'r': r,
        'lora_alpha': alpha,
        'lora_dropout': 0.0,
        'bias': 'none',
        'fan_in_fanout': False,
        'inference_mode': True,
        'target_modules': list(dict.fromkeys(t for _, _, t, _ in todo)),
        'throwaway': {'seed': a.seed, 'strength': a.strength, 'trained': False},
    }, indent=2), encoding='utf-8')
    params = sum(v.numel() for v in tensors.values())
    print(f'{len(tensors) // 2} add-on weights, rank {r}, alpha {alpha:g}, {params:,} parameters, '
          f'each change {a.strength:.0%} of its weight (mean |dW| {sum(sizes) / len(sizes):.3f}) -> {a.out}')


if __name__ == '__main__':
    main()
