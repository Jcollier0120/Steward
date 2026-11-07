"""OpenVINO GenAI's VLMPipeline with LoRA add-ons, for intel.ts: one pipeline on one device, driven over stdin.

The kit's Intel NPU chat is OpenVINO Model Server, whose LLM graphs take no add-on (kit/spec/ACCELERATORS.md, Add-ons),
so the test runs the pipeline OpenVINO Model Server runs on the NPU, GenAI's VLMPipeline, directly. Every add-on is
loaded when the pipeline is made (AdapterConfig, MODE_AUTO: dynamic on CPU, GPU and NPU), and each request says which
one it applies, and at what alpha, or none.

    python -I -X utf8 addon_ov.py --model <OpenVINO model folder> --device NPU|GPU|CPU
        [--lora name=<adapter_model.safetensors> ...] [--prop KEY=VALUE ...]

GenAI ignores the add-on file's own alpha: a request's alpha is the whole scale of B @ A, so PEFT's lora_alpha / r
(llama.cpp's scale 1) is alpha = lora_alpha / r.

One JSON object a line in; each answer is a line starting "@@" (OpenVINO's own output goes to the same streams):
    {"op": "generate", "messages": [...], "prefix": "NAME:", "max_new_tokens": 32, "ignore_eos": false,
     "adapter": "name" | null, "alpha": 2.0, "images": ["<png>"]}
        -> {"text", "inputTokens", "outputTokens", "ttftMs", "tpotMs", "wallMs"}
       A picture's place in a message is GenAI's own tag, <ov_genai_image_0>: the chat template is applied here, as
       text, so the pipeline doesn't put the picture before it (Pillow reads the file).
    {"op": "odds", "messages": [...], "prefix": "NAME:", "adapter", "alpha", "samples": 24, "top_k": 8}
        -> {"odds": {token: logprob}, "wallMs"}: the first token's raw log-probabilities, gathered by sampling at a
           high temperature among the top_k: GenAI returns each sampled token's raw log-probability (logprobs=1),
           whatever the temperature; greedy decoding returns only the top one's.
    {"op": "quit"}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time


def say(obj: dict) -> None:
    sys.stdout.write('@@' + json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def value(v: str):
    if v in ('true', 'false'):
        return v == 'true'
    try:
        return int(v)
    except ValueError:
        return v


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--device', required=True)
    ap.add_argument('--lora', action='append', default=[], help='name=<adapter_model.safetensors>')
    ap.add_argument('--prop', action='append', default=[], help='KEY=VALUE, a pipeline property')
    a = ap.parse_args()

    import openvino_genai as g

    props = {}
    for p in a.prop:
        k, v = p.split('=', 1)
        props[k] = value(v)
    adapters: dict[str, object] = {}
    t0 = time.perf_counter()
    if a.lora:
        config = g.AdapterConfig()
        for spec in a.lora:
            name, file = spec.split('=', 1)
            adapters[name] = g.Adapter(file)
            config.add(adapters[name], 0.0)
        props['adapters'] = config
    try:
        pipe = g.VLMPipeline(a.model, a.device, **props)
    except Exception as e:  # noqa: BLE001: the reason is the result
        say({'ready': False, 'error': str(e), 'loadMs': (time.perf_counter() - t0) * 1000})
        return
    tok = pipe.get_tokenizer()
    say({'ready': True, 'pid': os.getpid(), 'loadMs': (time.perf_counter() - t0) * 1000,
         'versions': {'genai': g.__version__}, 'adapters': list(adapters)})

    def picture(file: str):
        import numpy as np
        import openvino as ov
        from PIL import Image

        with Image.open(file) as im:
            return ov.Tensor(np.ascontiguousarray(np.asarray(im.convert('RGB'), dtype=np.uint8)[None]))

    def prompt_of(m: dict) -> str:
        return tok.apply_chat_template(m['messages'], add_generation_prompt=True) + m.get('prefix', '')

    def config_of(m: dict):
        gc = pipe.get_generation_config()
        gc.apply_chat_template = False
        gc.max_new_tokens = int(m.get('max_new_tokens', 32))
        gc.ignore_eos = bool(m.get('ignore_eos', False))
        gc.do_sample = False
        name = m.get('adapter')
        gc.adapters = g.AdapterConfig(adapters[name], float(m.get('alpha', 1.0))) if name else g.AdapterConfig()
        return gc

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        m = json.loads(line)
        try:
            if m['op'] == 'quit':
                say({'bye': True})
                return
            if m['op'] == 'generate':
                gc = config_of(m)
                extra = {'images': [picture(p) for p in m['images']]} if m.get('images') else {}
                t = time.perf_counter()
                r = pipe.generate(prompt_of(m), generation_config=gc, **extra)
                pm = r.perf_metrics
                say({'text': r.texts[0], 'inputTokens': pm.get_num_input_tokens(), 'outputTokens': pm.get_num_generated_tokens(),
                     'ttftMs': pm.get_ttft().mean, 'tpotMs': pm.get_tpot().mean, 'wallMs': (time.perf_counter() - t) * 1000})
            elif m['op'] == 'odds':
                gc = config_of(m)
                gc.max_new_tokens = 1
                gc.do_sample = True
                gc.temperature = float(m.get('temperature', 50.0))
                gc.top_k = int(m.get('top_k', 8))
                gc.top_p = 1.0
                gc.logprobs = 1
                prompt = prompt_of(m)
                odds: dict[str, float] = {}
                t = time.perf_counter()
                for s in range(int(m.get('samples', 24))):
                    gc.rng_seed = s + 1
                    r = pipe.generate(prompt, generation_config=gc)
                    odds[r.texts[0]] = float(r.scores[0])
                say({'odds': odds, 'wallMs': (time.perf_counter() - t) * 1000})
            else:
                say({'error': f"unknown op {m['op']}"})
        except Exception as e:  # noqa: BLE001: the reason is the result
            say({'error': str(e)})


if __name__ == '__main__':
    main()
