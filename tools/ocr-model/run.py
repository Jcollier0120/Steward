"""Runs a det+rec pair over the check's pictures and scores it.

    python run.py <fixtures> <models> <det> <rec> [det_scale] [out.json]
"""
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from pipeline import Det, Reader, Rec  # noqa: E402
from score import report  # noqa: E402

fx, models, det, rec = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]
scale = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
out = Path(sys.argv[6]) if len(sys.argv) > 6 else None
r = Reader(Det(models / det), Rec(models / rec), det_scale=scale)
truth = json.loads((fx / 'truth.json').read_text(encoding='utf-8-sig'))
texts, ms = {}, []
for t in truth:
    if t['group'] == 'pdf scan':
        continue
    text, m, n = r.read(fx / t['file'])
    texts[t['file']] = text
    ms.append(m)
name = f'{det}+{rec}@{scale}'
report(fx, texts, name)
print(f'  ms a picture (median) {statistics.median(ms):.0f}')
if out:
    out.write_text(json.dumps(texts, indent=1, ensure_ascii=False), encoding='utf-8')
