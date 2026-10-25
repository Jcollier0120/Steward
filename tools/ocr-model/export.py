"""The models as the kit's reader takes them (kit/node/ocr-npu.cs): det.onnx, rec.onnx and charset.txt, with the
license and notice that go with them (LICENSE.txt, NOTICE.txt): what the ocr-model-v<version> release holds.

    python export.py <models> <checkpoint.pt | -> <out dir> [--space-bias X] [--det <checkpoint.pt>] [--rec-only]

- det.onnx: PP-OCRv6 tiny's detector as published, its input [1, 3, h, w] (the reader fixes h and w at its tile size).
- rec.onnx: the fine-tuned recognizer (train.py's checkpoint; - for the published weights with our characters),
  [n, 3, 48, w] in (w a multiple of 8), logits [n, w / stride, classes] out (the checkpoint's stride, 8 or 4; no
  softmax: the reader takes the best class at each step), its one pooling written as the NPU runs it quickly
  (pool_as_means). --space-bias raises the space's logit by X (space_bias.py chooses it on the held-back lines), so
  every reader of the model gets it.
- charset.txt: the recognizer's characters, class 1 onwards.
- LICENSE.txt (Apache-2.0, as PaddleOCR's models are) and NOTICE.txt (what they are and how they were changed).
Each is checked against the model it came from on random input before it's written. --det takes a detector
distill_det.py trained; --rec-only writes rec.onnx alone, into a folder that has the rest.
"""
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from recnet import CHARSET, from_onnx  # noqa: E402

IR = 10  # ONNX Runtime 1.27 reads IR 10


def name_dims(model: onnx.ModelProto, dims: dict):
    """The graph's first input and output with these dimensions: numbers fixed, names left for the reader to fix."""
    for v, want in ((model.graph.input[0], dims['in']), (model.graph.output[0], dims['out'])):
        shape = v.type.tensor_type.shape
        for d, w in zip(shape.dim, want):
            d.Clear()
            if isinstance(w, int):
                d.dim_value = w
            else:
                d.dim_param = w
    return model


def pool_as_means(model: onnx.ModelProto):
    """The recognizer's AveragePool at its body's end (3 by 2 windows over a map 3 high) written as the means it is: over
    the height, then each pair of columns reshaped onto an axis of its own and averaged. The same answer; but Qualcomm's
    NPU runs the pool far slower than all the rest of the model (a line 512 wide took 4.3 ms, written so 0.44 ms). The
    pairs reshape needs the map's width even: the reader's widths are multiples of 8, the map a quarter of that. At
    stride 4 the pool is over the height alone (recnet.halve_stride): the mean over the height is all of it."""
    inferred = onnx.shape_inference.infer_shapes(model)
    dims = {v.name: [d.dim_value for d in v.type.tensor_type.shape.dim] for v in inferred.graph.value_info}
    for i, n in enumerate(list(model.graph.node)):
        if n.op_type != 'AveragePool':
            continue
        a = {x.name: onnx.helper.get_attribute_value(x) for x in n.attribute}
        kh, kw = a['kernel_shape']
        shape = dims.get(n.input[0], [])
        if list(a.get('strides', [])) != [kh, kw] or any(a.get('pads', [])) or len(shape) != 4 or shape[2] != kh:
            continue
        p = n.name
        if kw == 1:
            means = [onnx.helper.make_node('ReduceMean', [n.input[0]], list(n.output), axes=[2], keepdims=1, name=p + '/height')]
        else:
            for name, values in ((p + '/pairs_shape', [0, 0, -1, kw]), (p + '/row_shape', [0, 0, 1, -1])):
                model.graph.initializer.append(onnx.numpy_helper.from_array(np.array(values, np.int64), name))
            means = [
                onnx.helper.make_node('ReduceMean', [n.input[0]], [p + '/height'], axes=[2], keepdims=1, name=p + '/height'),
                onnx.helper.make_node('Reshape', [p + '/height', p + '/pairs_shape'], [p + '/pairs'], name=p + '/pairs'),
                onnx.helper.make_node('ReduceMean', [p + '/pairs'], [p + '/pair_means'], axes=[3], keepdims=1, name=p + '/pair_means'),
                onnx.helper.make_node('Reshape', [p + '/pair_means', p + '/row_shape'], list(n.output), name=p + '/row'),
            ]
        model.graph.node.remove(n)
        for k, m in enumerate(means):
            model.graph.node.insert(i + k, m)
    return model


def export_det(models: Path, out: Path, ckpt: str = ''):
    if ckpt:
        return export_det_trained(ckpt, out)
    m = onnx.load(str(models / 'v6-tiny-det' / 'inference.onnx'))
    m = name_dims(m, {'in': [1, 3, 'h', 'w'], 'out': [1, 1, 'h', 'w']})
    del m.graph.value_info[:]
    onnx.checker.check_model(m)
    onnx.save(m, str(out / 'det.onnx'))
    x = np.random.default_rng(0).standard_normal((1, 3, 640, 640)).astype(np.float32)
    a = ort.InferenceSession(str(models / 'v6-tiny-det' / 'inference.onnx')).run(None, {'x': x})[0]
    b = ort.InferenceSession(str(out / 'det.onnx')).run(None, {'x': x})[0]
    print('det.onnx', (out / 'det.onnx').stat().st_size, 'bytes; max difference', float(np.abs(a - b).max()))


def export_det_trained(ckpt: str, out: Path):
    """A detector distill_det.py trained (its GELUs swapped), its probability map out as the published one's."""
    from gelu_free import load
    saved = torch.load(ckpt, map_location='cpu')
    net = load(Path(saved['onnx']), saved['act'])
    net.load_state_dict(saved['model'])
    net.eval()
    path = out / 'det.onnx'
    torch.onnx.export(net, (torch.randn(1, 3, 640, 640),), str(path), input_names=['x'], output_names=['fetch_name_0'],
                      opset_version=17, dynamic_axes={'x': {2: 'h', 3: 'w'}, 'fetch_name_0': {2: 'h', 3: 'w'}}, dynamo=False)
    m = onnx.load(str(path))
    m.ir_version = IR
    m = name_dims(m, {'in': [1, 3, 'h', 'w'], 'out': [1, 1, 'h', 'w']})
    onnx.checker.check_model(m)
    onnx.save(m, str(path))
    s = ort.InferenceSession(str(path))
    worst = 0.0
    for h, w in ((640, 640), (320, 960)):
        x = torch.randn(1, 3, h, w)
        with torch.no_grad():
            want = net(x).numpy()
        worst = max(worst, float(np.abs(want - s.run(None, {'x': x.numpy()})[0]).max()))
    print('det.onnx', path.stat().st_size, 'bytes; max difference', worst)


def export_rec(models: Path, ckpt: str, out: Path, space_bias: float = 0.0):
    saved = torch.load(ckpt, map_location='cpu') if ckpt != '-' else None
    if saved and saved.get('onnx'):
        # Trained from an exported recognizer (train.py --onnx), its GELUs perhaps swapped: rebuilt as it was.
        from gelu_free import load
        if space_bias:
            sys.exit('--space-bias: not for a recognizer trained from an exported one')
        net = load(Path(saved['onnx']), saved.get('act', 'gelu'))
        net.load_state_dict(saved['model'])
    else:
        net = from_onnx(models / 'v6-tiny-rec', stride=saved.get('stride', 8) if saved else 8)
        if saved:
            net.load_state_dict(saved['model'])
        with torch.no_grad():
            net.head.bias[CHARSET.index(' ') + 1] += space_bias
    net.eval()
    x = torch.randn(2, 3, 48, 320)
    path = out / 'rec.onnx'
    torch.onnx.export(net, (x,), str(path), input_names=['x'], output_names=['y'], opset_version=17,
                      dynamic_axes={'x': {0: 'n', 3: 'w'}, 'y': {0: 'n', 1: 't'}}, dynamo=False)
    m = onnx.load(str(path))
    m.ir_version = IR
    m = pool_as_means(m)
    m = name_dims(m, {'in': ['n', 3, 48, 'w'], 'out': ['n', 't', len(CHARSET) + 1]})
    onnx.checker.check_model(m)
    onnx.save(m, str(path))
    s = ort.InferenceSession(str(path))
    worst = 0.0
    for n, w in ((1, 128), (8, 512), (1, 2048)):
        xi = torch.randn(n, 3, 48, w)
        with torch.no_grad():
            want = net(xi).numpy()
        got = s.run(None, {'x': xi.numpy()})[0]
        worst = max(worst, float(np.abs(want - got).max()))
    print('rec.onnx', path.stat().st_size, 'bytes; max difference', worst)


def main():
    models, ckpt, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    space_bias = float(sys.argv[sys.argv.index('--space-bias') + 1]) if '--space-bias' in sys.argv else 0.0
    det = sys.argv[sys.argv.index('--det') + 1] if '--det' in sys.argv else ''
    out.mkdir(parents=True, exist_ok=True)
    if '--rec-only' in sys.argv:
        # Into a folder that has the rest (gelu_free.py's, for AMD's NPU's copy).
        return export_rec(models, ckpt, out, space_bias)
    export_det(models, out, det)
    export_rec(models, ckpt, out, space_bias)
    (out / 'charset.txt').write_text(CHARSET, encoding='utf-8')
    for f in ('LICENSE.txt', 'NOTICE.txt'):
        (out / f).write_bytes((HERE / f).read_bytes().replace(b'\r\n', b'\n'))


if __name__ == '__main__':
    main()
