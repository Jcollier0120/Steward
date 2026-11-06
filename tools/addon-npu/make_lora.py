"""A throwaway LoRA add-on for Qwen3-VL-2B-Instruct's language model, in Hugging Face PEFT's layout.

Nothing is trained: A and B are seeded random numbers, and B is scaled so that each add-on's change to its weight,
(alpha / r) * B @ A, is a set fraction (--strength) of that weight's own size (Frobenius norms), read from the base
GGUF the add-on will run on. That is enough to test where an add-on runs and what it costs; a trained one has the
same shapes, so the same ops.

    python -I -X utf8 make_lora.py <out folder> --config <Qwen's config.json> --base-gguf <the 2B's GGUF>
        --gguf-py <llama.cpp>/gguf-py [--rank 16] [--strength 0.05] [--seed 1]

Then convert it with the matching llama.cpp's convert_lora_to_gguf.py (README.md beside this file).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TARGETS = ('q_proj', 'k_proj', 'v_proj', 'o_proj')
GGUF_NAME = {'q_proj': 'attn_q', 'k_proj': 'attn_k', 'v_proj': 'attn_v', 'o_proj': 'attn_output'}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('out', type=Path)
    ap.add_argument('--config', type=Path, required=True, help="Qwen3-VL-2B-Instruct's config.json")
    ap.add_argument('--base-gguf', type=Path, required=True, help='the base GGUF, to size each change against')
    ap.add_argument('--gguf-py', type=Path, required=True, help="the matching llama.cpp's gguf-py folder")
    ap.add_argument('--rank', type=int, default=16)
    ap.add_argument('--alpha', type=float, default=None, help='default: twice the rank')
    ap.add_argument('--strength', type=float, default=0.05, help="each change's size as a fraction of its weight's")
    ap.add_argument('--seed', type=int, default=1)
    a = ap.parse_args()

    sys.path.insert(0, str(a.gguf_py))
    import numpy as np
    import torch
    from gguf import GGUFReader
    from gguf.quants import dequantize
    from safetensors.torch import save_file

    cfg = json.loads(a.config.read_text(encoding='utf-8'))
    t = cfg['text_config']
    hidden, layers = t['hidden_size'], t['num_hidden_layers']
    head_dim = t.get('head_dim', hidden // t['num_attention_heads'])
    q_out, kv_out = t['num_attention_heads'] * head_dim, t['num_key_value_heads'] * head_dim
    shape = {'q_proj': (q_out, hidden), 'k_proj': (kv_out, hidden), 'v_proj': (kv_out, hidden), 'o_proj': (hidden, q_out)}
    r = a.rank
    alpha = a.alpha if a.alpha is not None else 2.0 * r

    reader = GGUFReader(a.base_gguf)
    base = {x.name: x for x in reader.tensors}

    def weight_norm(il: int, target: str) -> float:
        x = base[f'blk.{il}.{GGUF_NAME[target]}.weight']
        w = dequantize(x.data, x.tensor_type).astype(np.float32)
        return float(np.linalg.norm(w))

    g = torch.Generator().manual_seed(a.seed)
    tensors: dict[str, torch.Tensor] = {}
    sizes: list[float] = []
    for il in range(layers):
        for target in TARGETS:
            out_f, in_f = shape[target]
            A = torch.randn(r, in_f, generator=g) / in_f ** 0.5
            B = torch.randn(out_f, r, generator=g)
            delta = (alpha / r) * torch.linalg.matrix_norm(B @ A).item()
            want = a.strength * weight_norm(il, target)
            B *= want / delta
            sizes.append(want)
            key = f'base_model.model.model.language_model.layers.{il}.self_attn.{target}'
            tensors[f'{key}.lora_A.weight'] = A.contiguous()
            tensors[f'{key}.lora_B.weight'] = B.contiguous()

    a.out.mkdir(parents=True, exist_ok=True)
    save_file(tensors, str(a.out / 'adapter_model.safetensors'))
    (a.out / 'adapter_config.json').write_text(json.dumps({
        'peft_type': 'LORA',
        'task_type': 'CAUSAL_LM',
        'base_model_name_or_path': 'Qwen/Qwen3-VL-2B-Instruct',
        'r': r,
        'lora_alpha': alpha,
        'lora_dropout': 0.0,
        'bias': 'none',
        'fan_in_fanout': False,
        'inference_mode': True,
        'target_modules': list(TARGETS),
        'throwaway': {'seed': a.seed, 'strength': a.strength, 'trained': False},
    }, indent=2), encoding='utf-8')
    params = sum(v.numel() for v in tensors.values())
    print(f'{len(tensors) // 2} add-on weights, rank {r}, alpha {alpha:g}, {params:,} parameters, '
          f'each change {a.strength:.0%} of its weight (mean |dW| {sum(sizes) / len(sizes):.3f}) -> {a.out}')


if __name__ == '__main__':
    main()
