/**
 * An ONNX model written as its protobuf (onnx.proto, IR version 8), from a graph described in plain objects: just what
 * the kit's own graphs use (rerank-npu.ts' reranker, built on each PC from the model's own weights, so no graph is
 * shipped). Its initializers either hold their bytes or name a span of another file (ONNX's external data), so a graph
 * of gigabytes is a few hundred kilobytes here.
 */

/** ONNX's element types the kit's graphs use (TensorProto.DataType). */
export const FLOAT = 1;
export const INT64 = 7;

export type Attr = { name: string; i: number } | { name: string; f: number } | { name: string; ints: number[] };

export interface OnnxNode {
  op: string;
  name: string;
  inputs: string[];
  outputs: string[];
  attrs?: Attr[];
}

/** An initializer: its bytes here, or (`external`) a span of a file beside the model. */
export interface OnnxTensor {
  name: string;
  type: typeof FLOAT | typeof INT64;
  dims: number[];
  raw?: Uint8Array;
  external?: { location: string; offset: number; length: number };
}

export interface OnnxValue {
  name: string;
  type: typeof FLOAT | typeof INT64;
  dims: number[];
}

export interface OnnxGraph {
  name: string;
  nodes: OnnxNode[];
  initializers: OnnxTensor[];
  inputs: OnnxValue[];
  outputs: OnnxValue[];
}

/** Protobuf's wire format, as much of it as ONNX's messages need: varints, and length-delimited fields. */
class Writer {
  private parts: Uint8Array[] = [];
  private size = 0;

  private push(b: Uint8Array) {
    this.parts.push(b);
    this.size += b.length;
  }

  varint(v: number | bigint) {
    let x = BigInt.asUintN(64, BigInt(v));
    const out: number[] = [];
    do {
      let byte = Number(x & 0x7fn);
      x >>= 7n;
      if (x) byte |= 0x80;
      out.push(byte);
    } while (x);
    this.push(Uint8Array.from(out));
  }

  tag(field: number, wire: 0 | 2 | 5) {
    this.varint((field << 3) | wire);
  }

  int(field: number, v: number | bigint) {
    this.tag(field, 0);
    this.varint(v);
  }

  float(field: number, v: number) {
    this.tag(field, 5);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.push(b);
  }

  bytes(field: number, b: Uint8Array) {
    this.tag(field, 2);
    this.varint(b.length);
    this.push(b);
  }

  string(field: number, s: string) {
    this.bytes(field, new TextEncoder().encode(s));
  }

  message(field: number, write: (w: Writer) => void) {
    const w = new Writer();
    write(w);
    this.bytes(field, w.done());
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

function tensor(w: Writer, t: OnnxTensor) {
  for (const d of t.dims) w.int(1, d);
  w.int(2, t.type);
  w.string(8, t.name);
  if (t.external) {
    for (const [key, value] of [
      ['location', t.external.location],
      ['offset', String(t.external.offset)],
      ['length', String(t.external.length)],
    ])
      w.message(13, (e) => {
        e.string(1, key);
        e.string(2, value);
      });
    w.int(14, 1);
  } else w.bytes(9, t.raw ?? new Uint8Array(0));
}

function value(w: Writer, v: OnnxValue) {
  w.string(1, v.name);
  w.message(2, (type) =>
    type.message(1, (t) => {
      t.int(1, v.type);
      t.message(2, (shape) => {
        for (const d of v.dims) shape.message(1, (dim) => dim.int(1, d));
      });
    }),
  );
}

function attribute(w: Writer, a: Attr) {
  w.string(1, a.name);
  if ('i' in a) {
    w.int(3, a.i);
    w.int(20, 2);
  } else if ('f' in a) {
    w.float(2, a.f);
    w.int(20, 1);
  } else {
    for (const i of a.ints) w.int(8, i);
    w.int(20, 7);
  }
}

/** The model's bytes: `graph` at ONNX opset `opset`. */
export function onnxModel(graph: OnnxGraph, o: { opset: number; producer: string }): Uint8Array {
  const w = new Writer();
  w.int(1, 8);
  w.string(2, o.producer);
  w.message(7, (g) => {
    for (const n of graph.nodes)
      g.message(1, (m) => {
        for (const i of n.inputs) m.string(1, i);
        for (const out of n.outputs) m.string(2, out);
        m.string(3, n.name);
        m.string(4, n.op);
        for (const a of n.attrs ?? []) m.message(5, (x) => attribute(x, a));
      });
    g.string(2, graph.name);
    for (const t of graph.initializers) g.message(5, (m) => tensor(m, t));
    for (const v of graph.inputs) g.message(11, (m) => value(m, v));
    for (const v of graph.outputs) g.message(12, (m) => value(m, v));
  });
  w.message(8, (s) => {
    s.string(1, '');
    s.int(2, o.opset);
  });
  return w.done();
}

/** An INT64 initializer holding `values` (a shape, axes, a slice's bounds). */
export function int64s(name: string, values: (number | bigint)[], dims: number[] = [values.length]): OnnxTensor {
  const raw = new Uint8Array(values.length * 8);
  const v = new DataView(raw.buffer);
  values.forEach((x, i) => v.setBigInt64(i * 8, BigInt(x), true));
  return { name, type: INT64, dims, raw };
}

/** A FLOAT initializer holding `values` (a scalar when `dims` is empty). */
export function floats(name: string, values: ArrayLike<number>, dims: number[]): OnnxTensor {
  const f = Float32Array.from(values as ArrayLike<number>);
  return { name, type: FLOAT, dims, raw: new Uint8Array(f.buffer, f.byteOffset, f.byteLength) };
}
