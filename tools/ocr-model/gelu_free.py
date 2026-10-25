"""The reader's models with their GELUs swapped for an activation AMD's NPU computes exactly, as PyTorch modules to
fine-tune (the recognizer, train.py --onnx) or distill (the detector, distill_det.py).

AMD's NPU computes a GELU of its own, coarsely (inside the recognizer its outputs were off by about 12% of their range,
kit/spec/OCR.md), and a GELU built from exact ReLU pieces costs it as much energy as the processor spends. A ReLU it
computes exactly, fused into the convolution before it; HardSwish is an option to try. Each GELU in the exported graphs
is the pattern x / sqrt(2), Erf, + 1, times x, times 0.5 (or a Gelu node), and becomes one node of the new activation.
"""
from pathlib import Path

import onnx
import torch
import torch.nn as nn
from onnx import helper
from onnx2torch import convert

ACTS = {'relu': 'Relu', 'hardswish': 'HardSwish', 'hardgelu': 'HardSigmoid'}
# hardgelu: x times HardSigmoid(x) at this slope, x * clip(0.304 x + 0.5, 0, 1): the slope nearest a GELU over inputs
# spread as N(0, 2) (root-mean-square error 0.031, a ReLU's 0.105; HardSwish's slope, 1/6, gives 0.176).
HARDGELU_ALPHA = 0.304


def gelus(model: onnx.ModelProto):
    """Each GELU in the graph: (its input, its output, the nodes it's made of)."""
    g = model.graph
    users, producer = {}, {o: n for n in g.node for o in n.output}
    for n in g.node:
        for t in n.input:
            users.setdefault(t, []).append(n)
    found = [(n.input[0], n.output[0], [n]) for n in g.node if n.op_type == 'Gelu']
    for erf in [n for n in g.node if n.op_type == 'Erf']:
        div = producer[erf.input[0]]
        x = div.input[0]
        add1 = users[erf.output[0]][0]
        mul_a = users[add1.output[0]][0]
        mul_b = users[mul_a.output[0]][0]
        if [div.op_type, add1.op_type, mul_a.op_type, mul_b.op_type] != ['Div', 'Add', 'Mul', 'Mul'] \
                or x not in list(mul_a.input) + list(mul_b.input):
            raise SystemExit(f'{erf.name}: not the GELU pattern')
        found.append((x, mul_b.output[0], [div, erf, add1, mul_a, mul_b]))
    return found


def swap_gelus(model: onnx.ModelProto, act: str) -> int:
    """Every GELU of `model` replaced, in place, by `act` (relu, hardswish: one node; hardgelu: a HardSigmoid and a
    Mul); how many there were."""
    found = gelus(model)
    g = model.graph
    first = {id(parts[0]): (x, y, i) for i, (x, y, parts) in enumerate(found)}
    drop = {id(n) for _, _, parts in found for n in parts}
    nodes = []
    for n in g.node:
        if id(n) in first:
            x, y, i = first[id(n)]
            if act == 'hardgelu':
                nodes.append(helper.make_node('HardSigmoid', [x], [f'gelu_free_{i}/gate'], name=f'gelu_free_{i}/gate',
                                              alpha=HARDGELU_ALPHA, beta=0.5))
                nodes.append(helper.make_node('Mul', [x, f'gelu_free_{i}/gate'], [y], name=f'gelu_free_{i}'))
            else:
                nodes.append(helper.make_node(ACTS[act], [x], [y], name=f'gelu_free_{i}'))
        if id(n) not in drop:
            nodes.append(n)
    del g.node[:]
    g.node.extend(nodes)
    read = {t for n in g.node for t in n.input}
    for i in [i for i in g.initializer if i.name not in read]:
        g.initializer.remove(i)
    # The new op needs its opset: HardSwish is from 14, which both graphs are at or above.
    return len(found)


def explicit_pads(model: onnx.ModelProto) -> int:
    """Each stride-1 convolution or pool padded SAME (the detector's stem and its 2x2 max-pool) written with the pads
    it means, as onnx2torch takes them and AMD's compiler keeps them. How many."""
    done = 0
    for node in model.graph.node:
        if node.op_type not in ('Conv', 'MaxPool', 'AveragePool'):
            continue
        a = {x.name: helper.get_attribute_value(x) for x in node.attribute}
        pad = a.get('auto_pad', b'NOTSET')
        pad = pad.decode() if isinstance(pad, bytes) else pad
        if pad not in ('SAME_UPPER', 'SAME_LOWER'):
            continue
        kernel = a['kernel_shape']
        if any(s != 1 for s in a.get('strides', [1] * len(kernel))):
            raise SystemExit(f'{node.name}: SAME padding with a stride needs the input size; not handled')
        total = [(k - 1) * d for k, d in zip(kernel, a.get('dilations', [1] * len(kernel)))]
        small = [t // 2 for t in total]
        big = [t - s for t, s in zip(total, small)]
        begin, end = (small, big) if pad == 'SAME_UPPER' else (big, small)
        for x in [x for x in node.attribute if x.name in ('auto_pad', 'pads')]:
            node.attribute.remove(x)
        node.attribute.append(helper.make_attribute('pads', begin + end))
        done += 1
    return done


class Net(nn.Module):
    """A converted graph whose float constants of more than one value (weights, biases, scales) learn."""

    def __init__(self, gm: nn.Module):
        super().__init__()
        self.body = gm
        used = {str(n.target).split('.')[-1] for n in gm.graph.nodes if n.op == 'get_attr'}
        if hasattr(gm, 'initializers'):
            for name, buf in list(gm.initializers.named_buffers(recurse=False)):
                if name in used and buf.is_floating_point() and buf.numel() > 1:
                    delattr(gm.initializers, name)
                    gm.initializers.register_parameter(name, nn.Parameter(buf.detach().clone()))

    def forward(self, x):
        return self.body(x)

    def train(self, mode=True):
        # Batch norms keep their running statistics, as recnet.RecNet's: crops come in small batches of one width each.
        super().train(mode)
        for m in self.modules():
            if isinstance(m, (nn.BatchNorm1d, nn.BatchNorm2d)):
                m.eval()
        return self


def load(path: Path, act: str = 'gelu', logits: bool = False) -> nn.Module:
    """The ONNX model at `path` as a module to train, its GELUs swapped for `act` (gelu: as it is). `logits`: the
    detector's last Sigmoid left off, so it gives the logits its probability map is made of."""
    m = onnx.load(str(path))
    explicit_pads(m)
    if act != 'gelu':
        swap_gelus(m, act)
    if logits:
        out = m.graph.output[0].name
        sig = next(n for n in m.graph.node if out in n.output)
        if sig.op_type != 'Sigmoid':
            raise SystemExit(f'{path}: its output is not a Sigmoid\'s')
        m.graph.node.remove(sig)
        for n in m.graph.node:
            if sig.input[0] in n.output:
                n.output[list(n.output).index(sig.input[0])] = out
    return Net(convert(m))
