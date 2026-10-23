"""A PaddleOCR recognizer as a PyTorch module to fine-tune: its ONNX graph (onnx2torch), cut before its head (PP-OCRv6
tiny's 6,906-way, or another candidate's), with a head of our own over CHARSET whose rows start as the old head's rows
for those characters.

Outputs logits [N, W/8, len(CHARSET) + 1], class 0 the CTC blank, class k the character CHARSET[k - 1].
"""
from pathlib import Path

import onnx
import torch
import torch.nn as nn
import yaml
from onnx2torch import convert

# Printable ASCII with the space, Latin-1's letters, and the typography and symbols screens and documents use.
CHARSET = (
    ' ' + ''.join(chr(c) for c in range(0x21, 0x7f))
    + ''.join(chr(c) for c in range(0xc0, 0x100) if c not in (0xd7, 0xf7))
    + '€£¥¢©®™°±×÷µ§¶•…–—‘’“”«»¿¡→←↑↓✓·'
)


def old_dict(model_dir: Path):
    cfg = yaml.safe_load((model_dir / 'inference.yml').read_text(encoding='utf-8'))
    return [''] + [str(c) for c in cfg['PostProcess']['character_dict']] + [' ']


class RecNet(nn.Module):
    def __init__(self, body: nn.Module, feat: int, n_classes: int):
        super().__init__()
        self.body = body
        self.head = nn.Linear(feat, n_classes)

    def forward(self, x):
        return self.head(self.body(x))

    def train(self, mode=True):
        # Batch norms keep their running statistics: crops come in small batches of one width each.
        super().train(mode)
        for m in self.modules():
            if isinstance(m, (nn.BatchNorm1d, nn.BatchNorm2d)):
                m.eval()
        return self


def load_graph(path: Path) -> onnx.ModelProto:
    """The ONNX graph as onnx2torch takes it: an older export (PP-OCRv5's, opset 7) brought up to opset 13, its
    Constant nodes made initializers, and every tensor's shape inferred."""
    m = onnx.load(str(path))
    if next(o.version for o in m.opset_import if o.domain in ('', 'ai.onnx')) >= 11:
        return m
    from onnx import version_converter
    from onnxruntime.tools.symbolic_shape_infer import SymbolicShapeInference
    m = version_converter.convert_version(m, 13)
    keep = []
    for n in m.graph.node:
        if n.op_type == 'Constant':
            t = next(a for a in n.attribute if a.name == 'value').t
            t.name = n.output[0]
            m.graph.initializer.append(t)
        else:
            keep.append(n)
    del m.graph.node[:]
    m.graph.node.extend(keep)
    return SymbolicShapeInference.infer_shapes(m, auto_merge=True)


def from_onnx(model_dir: Path, charset: str = CHARSET) -> RecNet:
    model_dir = Path(model_dir)
    gm = convert(load_graph(model_dir / 'inference.onnx'))
    g = gm.graph
    # The head: Add(MatMul(feat, W), b) before the last softmax (a larger model has softmaxes in its attention too).
    softmax = [n for n in g.nodes if n.op == 'call_module' and 'Softmax' in str(n.target)][-1]
    add_head = softmax.args[0]
    while not ('Add' in str(add_head.target) and 'MatMul' in str(getattr(add_head.args[0], 'target', ''))):
        add_head = add_head.args[0]
    mat_mul = add_head.args[0]
    feat_node = mat_mul.args[0]
    w = getattr(gm.initializers, mat_mul.args[1].target.split('.')[-1]).detach().clone()
    b = getattr(gm.initializers, add_head.args[1].target.split('.')[-1]).detach().clone()
    out = next(n for n in g.nodes if n.op == 'output')
    out.args = (feat_node,)
    g.eliminate_dead_code()
    gm.recompile()
    gm.delete_all_unused_submodules()
    used = {str(n.target).split('.')[-1] for n in g.nodes if n.op == 'get_attr'}
    # The graph's float constants of more than one value (biases, scales) learn too; the old head's go.
    for name, buf in list(gm.initializers.named_buffers(recurse=False)):
        if name not in used:
            delattr(gm.initializers, name)
        elif buf.is_floating_point() and buf.numel() > 1:
            delattr(gm.initializers, name)
            gm.initializers.register_parameter(name, nn.Parameter(buf.detach().clone()))
    old = old_dict(model_dir)
    index = {c: i for i, c in enumerate(old) if c}
    net = RecNet(gm, w.shape[0], len(charset) + 1)
    with torch.no_grad():
        net.head.weight.zero_()
        net.head.bias.fill_(-10.0)
        net.head.weight[0] = w[:, 0]
        net.head.bias[0] = b[0]
        for k, c in enumerate(charset, start=1):
            i = index.get(c)
            if i is not None:
                net.head.weight[k] = w[:, i]
                net.head.bias[k] = b[i]
    return net


def decode(logits: torch.Tensor, charset: str = CHARSET):
    out = []
    for seq in logits.argmax(-1).tolist():
        s, prev = [], 0
        for k in seq:
            if k != prev and k != 0:
                s.append(charset[k - 1])
            prev = k
        out.append(''.join(s))
    return out
