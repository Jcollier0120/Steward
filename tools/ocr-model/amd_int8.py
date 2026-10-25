"""AMD's NPU's copy of the model (kit/node/ocr-npu.ts, AMD_MODEL_FILES): a models folder with no GELU left
(gelu_free.py's, its recognizer fine-tuned and exported again), rewritten exactly around two of VitisAI's compiler's
faults and three of its coarse operators, then quantized to int8, calibrated on the reader's own inputs.

    python amd_int8.py <models> <screens dir> <lines dir> <out dir>

The screens are screens.py's and the lines draw.py's (none of either the check's): 96 detector tiles cut as the reader
cuts them, and 24 lines at each of the widths the reader reads (128 to 2,048), padded as the reader pads them. The out
folder gets det.onnx and rec.onnx in QDQ: 16-bit activations, 8-bit weights per channel (16-bit weights crash
VitisAI's partitioner), every operator between a Q and a DQ so its compiler finds the whole graph quantized; and
LICENSE.txt and NOTICE.txt (NOTICE-amd.txt): the ocr-model-v<version>-amd release's assets.

The rewrites, each exact (or to float rounding):
- Identity nodes dropped (torch's export leaves them; the rewrites below look through none).
- SAME padding written out: VitisAI's int8 compiler (XIR) drops it (320 -> 319).
- A dilated convolution (the recognizer's 1x5, dilation 2) undilated, its kernel spread with zeros between the taps:
  XIR drops the dilation.
- Each HardSigmoid right after a convolution folded into it, then a clip to 0..1: no HardSigmoid of the NPU's is left.
- The recognizer's head kept 4-D (fix_head), so the NPU takes all of it; each squeeze-excite mean over the whole line
  split into a 1x16 pool and a mean (split_means); its last two MatMuls one 1x1 convolution (head_to_conv), which the
  NPU computes exactly where it read the MatMul/Add tail up to 10% off.
"""
import random
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper
from onnxruntime.quantization import CalibrationDataReader, CalibrationMethod, QuantFormat, QuantType, quantize_static
from onnxruntime.quantization.shape_inference import quant_pre_process
from PIL import Image

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from distill_det import TILE, to_input as det_input  # noqa: E402
from gelu_free import explicit_pads, gelus  # noqa: E402
from train import Lines, bucket  # noqa: E402

WIDTHS = (128, 256, 384, 512, 768, 1024, 1536, 2048)  # ocr-npu.cs, Reader.Buckets
TILES = 96
LINES_PER_WIDTH = 24


def attrs(node):
    return {a.name: helper.get_attribute_value(a) for a in node.attribute}


def set_attr(node, name, value):
    for a in list(node.attribute):
        if a.name == name:
            node.attribute.remove(a)
    if value is not None:
        node.attribute.append(helper.make_attribute(name, value))


def drop_unread(g):
    read = {t for n in g.node for t in n.input}
    for i in [i for i in g.initializer if i.name not in read]:
        g.initializer.remove(i)


def drop_identities(model) -> list:
    g = model.graph
    outs = {o.name for o in g.output}
    rename, keep = {}, []
    for n in g.node:
        if n.op_type == 'Identity' and n.output[0] not in outs:
            rename[n.output[0]] = rename.get(n.input[0], n.input[0])
            continue
        keep.append(n)
    for n in keep:
        for i, t in enumerate(n.input):
            if t in rename:
                n.input[i] = rename[t]
    del g.node[:]
    g.node.extend(keep)
    return [f'{len(rename)} Identity nodes dropped'] if rename else []


def undilate(model) -> list:
    inits = {i.name: i for i in model.graph.initializer}
    done = []
    for node in model.graph.node:
        dil = attrs(node).get('dilations')
        if node.op_type != 'Conv' or not dil or all(d == 1 for d in dil):
            continue
        w = inits[node.input[1]]
        k = numpy_helper.to_array(w)
        spread = np.zeros(k.shape[:2] + tuple((s - 1) * d + 1 for s, d in zip(k.shape[2:], dil)), dtype=k.dtype)
        spread[(slice(None), slice(None)) + tuple(slice(None, None, d) for d in dil)] = k
        w.CopyFrom(numpy_helper.from_array(spread, w.name))
        set_attr(node, 'dilations', [1] * len(dil))
        set_attr(node, 'kernel_shape', list(spread.shape[2:]))
        done.append(f'{node.name} dilations {dil} kernel {list(k.shape[2:])} -> kernel {list(spread.shape[2:])}')
    return done


def fold_hardsigmoids(model) -> list:
    """Each HardSigmoid (max(0, min(1, alpha x + beta))) right after a convolution nothing else reads, folded into it:
    the convolution's weights times alpha, its bias times alpha plus beta, then a clip to 0..1."""
    g = model.graph
    inits = {i.name: i for i in g.initializer}
    producer = {o: n for n in g.node for o in n.output}
    readers = {}
    for n in g.node:
        for t in n.input:
            readers[t] = readers.get(t, 0) + 1
    done = 0
    for n in g.node:
        if n.op_type != 'HardSigmoid':
            continue
        conv = producer.get(n.input[0])
        if conv is None or conv.op_type != 'Conv' or readers[n.input[0]] != 1 or conv.input[1] not in inits:
            continue
        a = attrs(n)
        alpha, beta = a.get('alpha', 0.2), a.get('beta', 0.5)
        w = inits[conv.input[1]]
        kernel = numpy_helper.to_array(w)
        w.CopyFrom(numpy_helper.from_array((kernel * alpha).astype(np.float32), w.name))
        bias = numpy_helper.to_array(inits[conv.input[2]]) if len(conv.input) > 2 else np.zeros(kernel.shape[0], np.float32)
        b = numpy_helper.from_array((bias * alpha + beta).astype(np.float32), conv.name + '.hsig_bias')
        g.initializer.append(b)
        if len(conv.input) > 2:
            conv.input[2] = b.name
        else:
            conv.input.append(b.name)
        if 'hsig_low' not in inits:
            g.initializer.extend([numpy_helper.from_array(np.array(0.0, np.float32), 'hsig_low'), numpy_helper.from_array(np.array(1.0, np.float32), 'hsig_high')])
            inits['hsig_low'] = True
        n.op_type = 'Clip'
        del n.attribute[:]
        n.input.extend(['hsig_low', 'hsig_high'])
        done += 1
    drop_unread(g)
    return [f'{done} HardSigmoids folded into the convolutions before them'] if done else []


def fix_head(model) -> list:
    """The recognizer's head kept 4-D: the mean over the height (3) a depthwise convolution (VitisAI has no 16-bit
    reduce-mean), the Squeeze/Unsqueeze pairs around it gone, each batch-norm on a squeezed tensor folded into the
    convolution before it, and one Squeeze moved to just before the transpose that needs 3-D."""
    g = model.graph
    inits = {i.name: i for i in g.initializer}
    consts = {n.output[0]: n for n in g.node if n.op_type == 'Constant'}
    shapes = {v.name: [d.dim_value or d.dim_param for d in v.type.tensor_type.shape.dim] for v in onnx.shape_inference.infer_shapes(model).graph.value_info}

    def axes_of(node):
        if len(node.input) > 1:
            t = node.input[1]
            return list(numpy_helper.to_array(inits[t] if t in inits else consts[t].attribute[0].t))
        return list(attrs(node).get('axes', []))

    def users(t):
        return [n for n in g.node if t in n.input]

    done, nodes, rename, four, skip = [], [], {}, set(), set()
    squeeze_axes = None
    for node in list(g.node):
        if node.name in skip:
            continue
        for i, t in enumerate(node.input):
            if t in rename:
                node.input[i] = rename[t]
        if node.op_type == 'ReduceMean' and axes_of(node) == [2] and attrs(node).get('keepdims', 1) == 1:
            n, c, h, w = shapes[node.input[0]]
            k = numpy_helper.from_array(np.full((c, 1, h, 1), 1.0 / h, dtype=np.float32), node.name + '.mean_weight')
            g.initializer.append(k)
            nodes.append(helper.make_node('Conv', [node.input[0], k.name], list(node.output), name=node.name + '.mean', group=c, kernel_shape=[h, 1], pads=[0, 0, 0, 0], strides=[1, 1], dilations=[1, 1]))
            done.append(f'{node.name}: the mean over a height of {h} -> a depthwise convolution')
            continue
        if node.op_type == 'Squeeze' and axes_of(node) == [2]:
            squeeze_axes = node.input[1]
            after = users(node.output[0])
            if len(after) == 1 and after[0].op_type == 'Unsqueeze' and axes_of(after[0]) == [2]:
                rename[after[0].output[0]] = node.input[0]
                skip.add(after[0].name)
                done.append(f'{node.name} and {after[0].name} dropped')
                continue
            before = [n for n in nodes if node.input[0] in n.output]
            if len(after) == 1 and after[0].op_type == 'BatchNormalization' and before and before[0].op_type == 'Conv':
                conv, bn = before[0], after[0]
                gamma, beta, mean, var = (numpy_helper.to_array(inits[t]) for t in bn.input[1:5])
                scale = gamma / np.sqrt(var + attrs(bn).get('epsilon', 1e-5))
                w = inits[conv.input[1]]
                kernel = numpy_helper.to_array(w)
                w.CopyFrom(numpy_helper.from_array((kernel * scale[:, None, None, None]).astype(np.float32), w.name))
                bias = numpy_helper.to_array(inits[conv.input[2]]) if len(conv.input) > 2 else np.zeros(kernel.shape[0], np.float32)
                b = numpy_helper.from_array(((bias - mean) * scale + beta).astype(np.float32), conv.name + '.bn_bias')
                g.initializer.append(b)
                if len(conv.input) > 2:
                    conv.input[2] = b.name
                else:
                    conv.input.append(b.name)
                rename[bn.output[0]] = conv.output[0]
                skip.add(bn.name)
                four.add(conv.output[0])
                done.append(f'{bn.name} folded into {conv.name}; {node.name} dropped')
                continue
        if any(t in four for t in node.input):
            if node.op_type == 'Unsqueeze' and axes_of(node) == [2]:
                rename[node.output[0]] = node.input[0]
                done.append(f'{node.name} dropped')
                continue
            if node.op_type in ('Mul', 'Add', 'Sub', 'Div', 'Clip') and all(t in four or t in consts or t in inits or t == '' for t in node.input):
                four.add(node.output[0])
            elif node.op_type != 'Conv':
                flat = node.input[0] + '_3d'
                nodes.append(helper.make_node('Squeeze', [node.input[0], squeeze_axes], [flat], name=node.name + '.squeeze'))
                node.input[0] = flat
                done.append(f'the Squeeze moved to just before {node.name}')
        nodes.append(node)
    del g.node[:]
    g.node.extend(nodes)
    # What nothing reads any more (the batch-norms' parameters, the dropped Unsqueezes' axes) goes.
    while True:
        read = {t for n in g.node for t in n.input} | {o.name for o in g.output}
        dead = [n for n in g.node if not any(o in read for o in n.output)]
        if not dead:
            break
        for n in dead:
            g.node.remove(n)
    drop_unread(g)
    return done


def split_means(model) -> list:
    """Each squeeze-excite mean over the whole height and width a 1x16 average pool and then the same mean, so no pool
    on the NPU is wider than its kernels reach (32), nor strides further (16): exact when the width there (a quarter of
    the line's) is a multiple of 16, as every AMD width (a multiple of 128) gives."""
    g = model.graph
    consts = {n.output[0]: n for n in g.node if n.op_type == 'Constant'}
    nodes, done = [], []
    for node in g.node:
        if node.op_type == 'ReduceMean':
            a = attrs(node)
            axes = a.get('axes') or (list(numpy_helper.to_array(consts[node.input[1]].attribute[0].t)) if len(node.input) > 1 and node.input[1] in consts else None)
            if axes == [2, 3] and a.get('keepdims', 1) == 1:
                pooled = node.input[0] + '_by16'
                nodes.append(helper.make_node('AveragePool', [node.input[0]], [pooled], name=node.name + '.by16', kernel_shape=[1, 16], strides=[1, 16], pads=[0, 0, 0, 0]))
                node.input[0] = pooled
                done.append(f'{node.name}: a 1x16 average pool, then the mean')
        nodes.append(node)
    del g.node[:]
    g.node.extend(nodes)
    return done


def head_to_conv(model) -> list:
    """The recognizer's last two linear layers (MatMul, add, MatMul, add, after the squeeze and transpose to [n, width,
    channels]) one 1x1 convolution before them: its weights the two matrices' product, its bias the first bias through
    the second matrix plus the second. Then the squeeze and transpose, as before."""
    g = model.graph
    inits = {i.name: i for i in g.initializer}
    out = g.output[0].name
    producer = {o: n for n in g.node for o in n.output}
    add1 = producer[out]
    mm1 = producer[[t for t in add1.input if t not in inits][0]]
    add0 = producer[mm1.input[0]]
    mm0 = producer[[t for t in add0.input if t not in inits][0]]
    tr = producer[mm0.input[0]]
    sq = producer[tr.input[0]]
    if [n.op_type for n in (sq, tr, mm0, add0, mm1, add1)] != ['Squeeze', 'Transpose', 'MatMul', 'Add', 'MatMul', 'Add']:
        raise SystemExit("the recognizer's head is not Squeeze, Transpose, MatMul, Add, MatMul, Add")
    arr = lambda n: numpy_helper.to_array(inits[[t for t in n.input if t in inits][0]]).astype(np.float64)
    w0, b0, w1, b1 = arr(mm0), arr(add0), arr(mm1), arr(add1)
    w = (w0 @ w1).T[:, :, None, None].astype(np.float32)
    b = (b0 @ w1 + b1).astype(np.float32)
    g.initializer.extend([numpy_helper.from_array(w, 'head.conv_weight'), numpy_helper.from_array(b, 'head.conv_bias')])
    conv = helper.make_node('Conv', [sq.input[0], 'head.conv_weight', 'head.conv_bias'], ['head.conv_out'], name='head.conv', group=1, kernel_shape=[1, 1], strides=[1, 1], pads=[0, 0, 0, 0], dilations=[1, 1])
    sq.input[0] = 'head.conv_out'
    tr.output[0] = out
    drop = {mm0.name, add0.name, mm1.name, add1.name}
    nodes = []
    for n in g.node:
        if n is sq:
            nodes.append(conv)
        if n.name not in drop:
            nodes.append(n)
    del g.node[:]
    g.node.extend(nodes)
    drop_unread(g)
    return [f'the head (MatMul {list(w0.shape)}, add, MatMul {list(w1.shape)}, add) -> one 1x1 convolution {list(w.shape[:2])}']


def rewrite(model: onnx.ModelProto, name: str) -> list:
    if gelus(model):
        raise SystemExit(f'{name}.onnx has GELUs; swap them first (gelu_free.py)')
    done = drop_identities(model)
    n = explicit_pads(model)
    done += [f'{n} SAME paddings written out'] if n else []
    done += undilate(model)
    if name == 'rec':
        done += fix_head(model) + split_means(model) + head_to_conv(model)
    done += fold_hardsigmoids(model)
    onnx.checker.check_model(model)
    return done


def check(before: onnx.ModelProto, after: onnx.ModelProto, x: np.ndarray) -> float:
    import onnxruntime as ort
    a = ort.InferenceSession(before.SerializeToString()).run(None, {'x': x})[0]
    b = ort.InferenceSession(after.SerializeToString()).run(None, {'x': x})[0]
    return float(np.abs(a - b).max())


class Inputs(CalibrationDataReader):
    def __init__(self, xs):
        self.xs = iter(xs)

    def get_next(self):
        x = next(self.xs, None)
        return None if x is None else {'x': x}


def tiles(screens: Path, r: random.Random):
    """Detector tiles as the reader cuts them; one in eight a picture smaller than a tile, the rest of it 0."""
    files = sorted(screens.glob('*.png'))
    for k in range(TILES):
        im = Image.open(r.choice(files)).convert('RGB')
        w, h = (TILE, TILE) if k % 8 else (r.randint(160, TILE), r.randint(48, TILE))
        w, h = min(w, im.width), min(h, im.height)
        x0, y0 = r.randint(0, im.width - w), r.randint(0, im.height - h)
        yield det_input(np.asarray(im.crop((x0, y0, x0 + w, y0 + h)))[:, :, ::-1])[None]


def lines(root: Path, r: random.Random):
    """Line images at each of the reader's widths, padded with 0 to it as the reader pads them."""
    ds = Lines([root], False, 4)
    want = {w: LINES_PER_WIDTH for w in WIDTHS}
    order = list(range(len(ds)))
    r.shuffle(order)
    for i in order:
        if not any(want.values()):
            break
        x = ds[i][0]
        w = bucket(x.shape[2])
        if want.get(w, 0) <= 0:
            continue
        want[w] -= 1
        pad = np.zeros((1, 3, 48, w), np.float32)
        pad[0, :, :, :x.shape[2]] = x
        yield pad


def quantize(fixed: Path, out: Path, inputs):
    pre = out.with_suffix('.pre.onnx')
    quant_pre_process(str(fixed), str(pre), skip_symbolic_shape=True)
    ops = sorted({n.op_type for n in onnx.load(str(pre)).graph.node} - {'Constant', 'Identity'})
    try:
        quantize_static(
            str(pre), str(out), Inputs(inputs),
            quant_format=QuantFormat.QDQ,
            activation_type=QuantType.QUInt16,
            weight_type=QuantType.QInt8,
            per_channel=True,
            op_types_to_quantize=ops,
            calibrate_method=CalibrationMethod.MinMax,
            extra_options={'ActivationSymmetric': False, 'WeightSymmetric': True, 'CalibMovingAverage': False, 'ForceQuantizeNoInputCheck': True},
        )
    finally:
        pre.unlink(missing_ok=True)


def main():
    models, screens, lines_dir, out = (Path(a) for a in sys.argv[1:5])
    out.mkdir(parents=True, exist_ok=True)
    r = random.Random(20261025)
    for name, inputs, probe in (('det', lambda: tiles(screens, r), np.zeros((1, 3, TILE, TILE), np.float32)),
                                ('rec', lambda: lines(lines_dir, r), np.zeros((2, 3, 48, 512), np.float32))):
        model = onnx.load(str(models / f'{name}.onnx'))
        fixed = onnx.load(str(models / f'{name}.onnx'))
        done = rewrite(fixed, name)
        probe[:] = np.random.default_rng(0).standard_normal(probe.shape)
        print(name, *done, f'max difference {check(model, fixed, probe):.2e}', sep='\n  ')
        path = out / f'{name}.fixed.onnx'
        onnx.save(fixed, str(path))
        try:
            quantize(path, out / f'{name}.onnx', inputs())
        finally:
            path.unlink(missing_ok=True)
        print(f'  {name}.onnx', (out / f'{name}.onnx').stat().st_size, 'bytes, int8')
    for src, dest in (('LICENSE.txt', 'LICENSE.txt'), ('NOTICE-amd.txt', 'NOTICE.txt')):
        (out / dest).write_bytes((HERE / src).read_bytes().replace(b'\r\n', b'\n'))


if __name__ == '__main__':
    main()
