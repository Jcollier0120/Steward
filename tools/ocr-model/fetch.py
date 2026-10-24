"""Fetches the candidate models into models\<name>\, each pinned to a commit, and checks each ONNX file's SHA-256."""
import hashlib
import sys
import urllib.request
from pathlib import Path

DEST = Path(sys.argv[1])
HF = 'https://huggingface.co/{repo}/resolve/{rev}/{file}'
CANDIDATES = {
    'v6-tiny-rec': ('PaddlePaddle/PP-OCRv6_tiny_rec_onnx', '2612ab37152ae0a677521bae4e1e3d4fb4cf7c30', '9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6'),
    'v6-tiny-det': ('PaddlePaddle/PP-OCRv6_tiny_det_onnx', '2ba1506c0380b8f0b03dd142459aac66d4421f6c', '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8'),
    'v5-en-rec': ('PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx', '3fafbc3b5dcf93dd72add9f48368be8a3a2cd33b', 'b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f'),
    'v5-det': ('PaddlePaddle/PP-OCRv5_mobile_det_onnx', 'e6f4fa85f00e168c862bc462aebca69eef9b3d3d', 'a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d'),
}


def get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


for name, (repo, rev, sha) in CANDIDATES.items():
    d = DEST / name
    d.mkdir(parents=True, exist_ok=True)
    onnx = get(HF.format(repo=repo, rev=rev, file='inference.onnx'))
    got = hashlib.sha256(onnx).hexdigest()
    if got != sha:
        sys.exit(f'{name}: SHA-256 {got} is not {sha}')
    (d / 'inference.onnx').write_bytes(onnx)
    yml = get(HF.format(repo=repo, rev=rev, file='inference.yml'))
    (d / 'inference.yml').write_bytes(yml)
    print(name, len(onnx), 'bytes, SHA-256 ok; inference.yml', hashlib.sha256(yml).hexdigest())
