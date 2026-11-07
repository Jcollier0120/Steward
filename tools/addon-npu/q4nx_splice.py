"""Copy a q4nx and replace chosen tensors with the same-named, same-shaped tensors of another q4nx.

python -I q4nx_splice.py <base q4nx> <donor q4nx> <out q4nx> <regex of tensor names to take from the donor>
"""
import json
import re
import shutil
import struct
import sys


def header(f):
    n = struct.unpack('<Q', f.read(8))[0]
    h = json.loads(f.read(n))
    h.pop('__metadata__', None)
    return 8 + n, h


base, donor, out, pattern = sys.argv[1:]
shutil.copyfile(base, out)
rx = re.compile(pattern)
with open(out, 'r+b') as fo, open(donor, 'rb') as fd:
    ob, hb = header(fo)
    od, hd = header(fd)
    names = sorted(k for k in hb if rx.search(k))
    for k in names:
        a, d = hb[k], hd.get(k)
        if d is None or a['dtype'] != d['dtype'] or a['shape'] != d['shape']:
            raise SystemExit(f'{k}: {a["dtype"]}{a["shape"]} in the base, {d and (d["dtype"], d["shape"])} in the donor')
        sa, ea = a['data_offsets']
        sd, ed = d['data_offsets']
        fd.seek(od + sd)
        buf = fd.read(ed - sd)
        fo.seek(ob + sa)
        fo.write(buf)
print(f'{len(names)} tensors taken from the donor -> {out}')
