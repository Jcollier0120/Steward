import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { FLOAT, floats, int64s, type OnnxGraph, onnxModel, type OnnxNode, type OnnxTensor } from './onnx-proto.ts';

/**
 * AMD's NPU's reranker, made on each PC from the model's own weights (rerank-npu.ts fetches them, pinned): no graph is
 * shipped, and nothing is uploaded. Qwen3-Reranker-0.6B as tomaarsen's seq-cls conversion has it (its "yes" logit less
 * its "no" one, as one score head), in the graph AMD's VitisAI compiler took in the trial (spec/NPU-VENDORS.md,
 * "Reranking on AMD's NPU"):
 *
 * - **The template's constant start is kept out of the graph.** The 60 tokens before the question (the system prompt,
 *   the instruction, "<Query>:") are the same for every document, so each layer's keys and values for them are worked out
 *   once, on the processor, by a graph of their own (startGraph), and are constants of the scoring graph. Qwen's first
 *   token carries a massive activation (about 8,100, against at most 414 for the others) that a BF16 NPU loses the rest
 *   of the stream to; without it, it ranks as the Radeon does. And no document pays for those 60 tokens.
 * - **One static length:** the scoring graph takes the 640 tokens after the start (the question, the document and the
 *   template's end), padded at the end; a longer document is cut to fit (rerank-npu.cs' Fit). The trial measured a 512
 *   graph beside it as faster (2,337 ms for ten files against 3,172), kept in the spec as the faster option.
 * - Each matrix transposed for MatMul, all in one file (weights.bin), the embedding table apart (table.f32): the
 *   program looks each token up itself, as the trial's server did.
 *
 * The graph is the trial's node for node (export_prefix.py's, as torch exported it at opset 17): RMSNorm as Pow, ReduceMean,
 * Add, Sqrt, Div and the weight's Mul; rope with full-size tables a head each (VitisAI miscompiles a broadcast one); the
 * 8 key-value heads repeated for the 16 query heads by Unsqueeze, Expand and Reshape; and the mask as -100, the start's
 * columns all visible.
 */

export const HIDDEN = 1024;
export const LAYERS = 28;
export const Q_HEADS = 16;
export const KV_HEADS = 8;
export const HEAD = 128;
export const FFN = 3072;
export const VOCAB = 151669;
const THETA = 1_000_000;
const EPS = 1e-6;

/** The scoring graph's tokens after the start: the question, the document and the template's end. */
export const MAX_TOKENS = 640;

/**
 * The template, as llama.cpp's Qwen3 rerank template has it (its relevance_score is the sigmoid of the logit at the last
 * token): PREFIX, then `<Instruct>: INSTRUCT\n<Query>: <question>\n<Document>: <document>`, then SUFFIX.
 */
export const PREFIX =
  '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n';
export const INSTRUCT = 'Given a web search query, retrieve relevant passages that answer the query';
export const SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n';
/** The constant start: every document's first 60 tokens. */
export const START = `${PREFIX}<Instruct>: ${INSTRUCT}\n<Query>:`;
/** The start's tokens, as Qwen's tokenizer makes them (the program checks its own against them before it scores). */
export const START_IDS: readonly number[] = Object.freeze([
  151644, 8948, 198, 60256, 3425, 279, 11789, 20027, 279, 8502, 3118, 389, 279, 11361, 323, 279, 758, 1235, 3897, 13, 7036, 429, 279, 4226, 646, 1172, 387, 330, 9693, 1, 476, 330, 2152, 3263, 151645, 198,
  151644, 872, 198, 27, 641, 1235, 26818, 16246, 264, 3482, 2711, 3239, 11, 17179, 9760, 46769, 429, 4226, 279, 3239, 198, 27, 2859, 26818,
]);
export const START_TOKENS = START_IDS.length;

/** The mask's value for a token a token mustn't see: -100, as the trial's graph (in BF16 a softmax's exp of it is nothing). */
const MASKED = -100;
/** On the processor (the start's graph, in FP32): far below anything a score reaches. */
const MASKED_CPU = -1e9;

// ------------------------------------------------------------------------------------------------
// The model's file

export interface SafeTensor {
  dtype: string;
  shape: number[];
  /** Where its bytes are in the file. */
  begin: number;
  end: number;
}

/** A safetensors file's tensors, from its header (8 bytes of length, then JSON), each at its place in the file. */
export function readSafetensorsHeader(file: string): Map<string, SafeTensor> {
  const fd = openSync(file, 'r');
  try {
    const len = Buffer.alloc(8);
    readSync(fd, len, 0, 8, 0);
    const n = Number(len.readBigUInt64LE(0));
    if (n <= 0 || n > 100_000_000) throw new Error(`${file} isn't a safetensors file (a header of ${n} bytes)`);
    const head = Buffer.alloc(n);
    readSync(fd, head, 0, n, 8);
    const json = JSON.parse(head.toString('utf8')) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
    const out = new Map<string, SafeTensor>();
    for (const [name, t] of Object.entries(json)) {
      if (name === '__metadata__') continue;
      out.set(name, { dtype: t.dtype, shape: t.shape, begin: 8 + n + t.data_offsets[0], end: 8 + n + t.data_offsets[1] });
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------------------------------------------
// weights.bin: what the graphs read from it

/** One of the model's tensors in weights.bin: its source in the safetensors file, transposed for MatMul when it's a matrix. */
export interface WeightSpan {
  name: string;
  source: string;
  dims: number[];
  transpose: boolean;
  offset: number;
  length: number;
}

/** Each span starts on a 64 KB boundary (Windows' allocation granularity), so a runtime may map it rather than read it. */
const ALIGN = 65536;

/** The tensors weights.bin holds and where: every layer's, then the final norm and the score head. Pure. */
export function weightLayout(): WeightSpan[] {
  const out: WeightSpan[] = [];
  let at = 0;
  const add = (name: string, source: string, dims: number[], transpose: boolean) => {
    const length = dims.reduce((a, b) => a * b, 1) * 4;
    out.push({ name, source, dims, transpose, offset: at, length });
    at = Math.ceil((at + length) / ALIGN) * ALIGN;
  };
  for (let l = 0; l < LAYERS; l++) {
    const m = `model.layers.${l}`;
    add(`l${l}.input_norm`, `${m}.input_layernorm.weight`, [HIDDEN], false);
    add(`l${l}.q`, `${m}.self_attn.q_proj.weight`, [HIDDEN, Q_HEADS * HEAD], true);
    add(`l${l}.k`, `${m}.self_attn.k_proj.weight`, [HIDDEN, KV_HEADS * HEAD], true);
    add(`l${l}.v`, `${m}.self_attn.v_proj.weight`, [HIDDEN, KV_HEADS * HEAD], true);
    add(`l${l}.o`, `${m}.self_attn.o_proj.weight`, [Q_HEADS * HEAD, HIDDEN], true);
    add(`l${l}.post_norm`, `${m}.post_attention_layernorm.weight`, [HIDDEN], false);
    add(`l${l}.gate`, `${m}.mlp.gate_proj.weight`, [HIDDEN, FFN], true);
    add(`l${l}.up`, `${m}.mlp.up_proj.weight`, [HIDDEN, FFN], true);
    add(`l${l}.down`, `${m}.mlp.down_proj.weight`, [FFN, HIDDEN], true);
  }
  add('norm', 'model.norm.weight', [HIDDEN], false);
  add('score', 'score.weight', [HIDDEN, 1], true);
  return out;
}

/** The small tensors the graph holds itself: each layer's q_norm and k_norm (128 values, inline as in the trial's). */
const SMALL = (l: number) => ({ q_norm: `model.layers.${l}.self_attn.q_norm.weight`, k_norm: `model.layers.${l}.self_attn.k_norm.weight` });

const readF32 = (fd: number, t: SafeTensor): Float32Array => {
  const b = Buffer.alloc(t.end - t.begin);
  let got = 0;
  while (got < b.length) {
    const n = readSync(fd, b, got, b.length - got, t.begin + got);
    if (!n) throw new Error('the model file ended early');
    got += n;
  }
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};

/** [rows, cols] row-major as [cols, rows], in blocks so both stay in the cache. */
export function transposed(a: Float32Array, rows: number, cols: number): Float32Array {
  const out = new Float32Array(a.length);
  const B = 64;
  for (let r0 = 0; r0 < rows; r0 += B)
    for (let c0 = 0; c0 < cols; c0 += B) {
      const r1 = Math.min(rows, r0 + B);
      const c1 = Math.min(cols, c0 + B);
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) out[c * rows + r] = a[r * cols + c];
    }
  return out;
}

const writeAll = (fd: number, b: Uint8Array, at: number) => {
  let done = 0;
  while (done < b.length) done += writeSync(fd, b, done, b.length - done, at + done);
};

/**
 * weights.bin and table.f32 from the model's safetensors file, every tensor checked against the layout (F32, its shape);
 * and the small tensors the graphs hold themselves. Throws on a file that isn't this model.
 */
export function exportWeights(safetensors: string, weightsFile: string, tableFile: string): { small: Map<string, Float32Array>; bytes: number } {
  const header = readSafetensorsHeader(safetensors);
  const want = (name: string, shape: number[]) => {
    const t = header.get(name);
    if (!t) throw new Error(`the model file has no ${name}`);
    if (t.dtype !== 'F32' || t.shape.join(',') !== shape.join(',')) throw new Error(`the model file's ${name} is ${t.dtype} [${t.shape}], not F32 [${shape}]`);
    return t;
  };
  const src = openSync(safetensors, 'r');
  try {
    const table = want('model.embed_tokens.weight', [VOCAB, HIDDEN]);
    const out = openSync(tableFile, 'w');
    try {
      const chunk = Buffer.alloc(64 << 20);
      for (let at = table.begin; at < table.end; ) {
        const n = readSync(src, chunk, 0, Math.min(chunk.length, table.end - at), at);
        if (!n) throw new Error('the model file ended early');
        writeAll(out, chunk.subarray(0, n), at - table.begin);
        at += n;
      }
    } finally {
      closeSync(out);
    }
    const layout = weightLayout();
    const w = openSync(weightsFile, 'w');
    let bytes = 0;
    try {
      for (const s of layout) {
        const shape = s.transpose ? [s.dims[1], s.dims[0]] : s.dims;
        const a = readF32(src, want(s.source, shape));
        const v = s.transpose ? transposed(a, shape[0], shape[1]) : a;
        writeAll(w, new Uint8Array(v.buffer, v.byteOffset, v.byteLength), s.offset);
        bytes = s.offset + s.length;
      }
    } finally {
      closeSync(w);
    }
    const small = new Map<string, Float32Array>();
    for (let l = 0; l < LAYERS; l++) for (const [k, name] of Object.entries(SMALL(l))) small.set(`l${l}.${k}`, readF32(src, want(name, [HEAD])).slice());
    return { small, bytes };
  } finally {
    closeSync(src);
  }
}

// ------------------------------------------------------------------------------------------------
// The graphs

/** Rope's tables for positions `from`..`from+n-1`, a head each ([1, heads, n, 128]), in FP32 as Qwen3's rotary embedding works them out. */
export function ropeTables(from: number, n: number, heads: number): { cos: Float32Array; sin: Float32Array } {
  const half = HEAD / 2;
  const f = Math.fround;
  const inv = Array.from({ length: half }, (_, i) => f(1 / f(Math.pow(THETA, f((2 * i) / HEAD)))));
  const cos = new Float32Array(heads * n * HEAD);
  const sin = new Float32Array(heads * n * HEAD);
  for (let p = 0; p < n; p++)
    for (let i = 0; i < HEAD; i++) {
      const a = f((from + p) * inv[i % half]);
      cos[p * HEAD + i] = Math.cos(a);
      sin[p * HEAD + i] = Math.sin(a);
    }
  for (let h = 1; h < heads; h++) {
    cos.copyWithin(h * n * HEAD, 0, n * HEAD);
    sin.copyWithin(h * n * HEAD, 0, n * HEAD);
  }
  return { cos, sin };
}

/** The mask [1, 1, n, start + n]: the start's columns visible, the tokens' own causal, `masked` where one mustn't see. */
export function maskTable(start: number, n: number, masked: number): Float32Array {
  const t = start + n;
  const m = new Float32Array(n * t);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) m[i * t + start + j] = masked;
  return m;
}

export interface GraphOptions {
  /** The tokens it takes. */
  tokens: number;
  /** The start's tokens before them, whose keys and values (`startKv`) it holds: 0 for the start's own graph. */
  start: number;
  /** Each layer's keys then values for the start, [layers * 2, 8, start, 128], from the start's graph. */
  startKv?: Float32Array;
  small: Map<string, Float32Array>;
  /** weights.bin's name beside the model. */
  weights: string;
}

/**
 * The scoring graph (`start` > 0: inputs_embeds [1, tokens, 1024] → scores [1, tokens], the start's keys and values
 * constants) or the start's own (`start` 0: inputs_embeds [1, 60, 1024] → kv [56, 8, 60, 128], each layer's keys after
 * rope and then its values). Pure: the weights stay in weights.bin.
 */
export function rerankGraph(o: GraphOptions): OnnxGraph {
  const S = o.tokens;
  const P = o.start;
  const T = P + S;
  const scoring = P > 0;
  if (scoring && o.startKv?.length !== LAYERS * 2 * KV_HEADS * P * HEAD) throw new Error("the scoring graph needs the start's keys and values");
  const nodes: OnnxNode[] = [];
  const inits: OnnxTensor[] = [];
  const spans = new Map(weightLayout().map((s) => [s.name, s]));
  const weight = (name: string) => {
    const s = spans.get(name)!;
    inits.push({ name, type: FLOAT, dims: s.dims, external: { location: o.weights, offset: s.offset, length: s.length } });
    return name;
  };
  const small = (name: string) => {
    inits.push(floats(name, o.small.get(name)!, [HEAD]));
    return name;
  };
  let n = 0;
  const node = (op: string, inputs: string[], attrs?: OnnxNode['attrs'], name?: string) => {
    const out = `${name ?? op}_${n++}`;
    nodes.push({ op, name: out, inputs, outputs: [out], ...(attrs ? { attrs } : {}) });
    return out;
  };

  // The constants, once each.
  inits.push(floats('two', [2], []), floats('eps', [EPS], []), floats('scale', [1 / Math.sqrt(HEAD)], []));
  inits.push(int64s('heads_shape', [1, S, -1, HEAD]), int64s('half', [HEAD / 2]), int64s('end', [9223372036854775807n]), int64s('last_axis', [3]), int64s('one', [1]), int64s('zero', [0]));
  inits.push(int64s('axis2', [2]), int64s('repeat', [1, KV_HEADS, Q_HEADS / KV_HEADS, T, HEAD]), int64s('kv_shape', [1, Q_HEADS, T, HEAD]), int64s('out_shape', [1, S, -1]));
  const q = ropeTables(P, S, Q_HEADS);
  const k = ropeTables(P, S, KV_HEADS);
  inits.push(floats('cq', q.cos, [1, Q_HEADS, S, HEAD]), floats('sq', q.sin, [1, Q_HEADS, S, HEAD]), floats('ck', k.cos, [1, KV_HEADS, S, HEAD]), floats('sk', k.sin, [1, KV_HEADS, S, HEAD]));
  inits.push(floats('mask', maskTable(P, S, scoring ? MASKED : MASKED_CPU), [1, 1, S, T]));

  const rmsNorm = (x: string, w: string, at: string) => {
    const mean = node('ReduceMean', [node('Pow', [x, 'two'], undefined, `${at}/Pow`)], [{ name: 'axes', ints: [-1] }, { name: 'keepdims', i: 1 }], `${at}/ReduceMean`);
    const root = node('Sqrt', [node('Add', [mean, 'eps'], undefined, `${at}/Add`)], undefined, `${at}/Sqrt`);
    return node('Mul', [w, node('Div', [x, root], undefined, `${at}/Div`)], undefined, `${at}/Mul`);
  };
  const reshape = (x: string, shape: string, at: string) => node('Reshape', [x, shape], [{ name: 'allowzero', i: 0 }], at);
  const transpose = (x: string, perm: number[], at: string) => node('Transpose', [x], [{ name: 'perm', ints: perm }], at);
  const rope = (x: string, c: string, s: string, at: string) => {
    const upper = node('Neg', [node('Slice', [x, 'half', 'end', 'last_axis', 'one'], undefined, `${at}/Slice`)], undefined, `${at}/Neg`);
    const lower = node('Slice', [x, 'zero', 'half', 'last_axis', 'one'], undefined, `${at}/Slice`);
    const rotated = node('Concat', [upper, lower], [{ name: 'axis', i: -1 }], `${at}/Concat`);
    const sinPart = node('Mul', [rotated, s], undefined, `${at}/Mul`);
    return node('Add', [node('Mul', [x, c], undefined, `${at}/Mul`), sinPart], undefined, `${at}/Add`);
  };
  /** The 8 heads' keys or values, each twice, for the 16 query heads. */
  const repeated = (x: string, at: string) => reshape(node('Expand', [node('Unsqueeze', [x, 'axis2'], undefined, `${at}/Unsqueeze`), 'repeat'], undefined, `${at}/Expand`), 'kv_shape', `${at}/Reshape`);

  const kv: string[] = [];
  let h = 'inputs_embeds';
  for (let l = 0; l < LAYERS; l++) {
    const at = `l${l}`;
    const x = rmsNorm(h, weight(`${at}.input_norm`), `${at}/input_norm`);
    // Keys: projected, normed a head each, rope; the start's before them.
    const kHeads = reshape(node('MatMul', [x, weight(`${at}.k`)], undefined, `${at}/k_proj`), 'heads_shape', `${at}/k/Reshape`);
    let key = rope(transpose(rmsNorm(kHeads, small(`${at}.k_norm`), `${at}/k_norm`), [0, 2, 1, 3], `${at}/k/Transpose`), 'ck', 'sk', `${at}/k/rope`);
    if (scoring) {
      inits.push(floats(`${at}.pk`, o.startKv!.subarray((2 * l) * KV_HEADS * P * HEAD, (2 * l + 1) * KV_HEADS * P * HEAD), [1, KV_HEADS, P, HEAD]));
      key = node('Concat', [`${at}.pk`, key], [{ name: 'axis', i: 2 }], `${at}/k/Concat`);
    } else kv[2 * l] = key;
    const values = () => {
      const v = transpose(reshape(node('MatMul', [x, weight(`${at}.v`)], undefined, `${at}/v_proj`), 'heads_shape', `${at}/v/Reshape`), [0, 2, 1, 3], `${at}/v/Transpose`);
      if (!scoring) return (kv[2 * l + 1] = v);
      inits.push(floats(`${at}.pv`, o.startKv!.subarray((2 * l + 1) * KV_HEADS * P * HEAD, (2 * l + 2) * KV_HEADS * P * HEAD), [1, KV_HEADS, P, HEAD]));
      return node('Concat', [`${at}.pv`, v], [{ name: 'axis', i: 2 }], `${at}/v/Concat`);
    };
    // The start's graph needs only the keys and values, so it stops at the last layer's.
    if (!scoring && l === LAYERS - 1) {
      values();
      break;
    }
    const keysT = transpose(repeated(key, `${at}/k`), [0, 1, 3, 2], `${at}/k/TransposeT`);
    // Queries the same way, then the scores of each against every key.
    const qHeads = reshape(node('MatMul', [x, weight(`${at}.q`)], undefined, `${at}/q_proj`), 'heads_shape', `${at}/q/Reshape`);
    const query = rope(transpose(rmsNorm(qHeads, small(`${at}.q_norm`), `${at}/q_norm`), [0, 2, 1, 3], `${at}/q/Transpose`), 'cq', 'sq', `${at}/q/rope`);
    const scores = node('Add', [node('Mul', [node('MatMul', [query, keysT], undefined, `${at}/qk`), 'scale'], undefined, `${at}/scale`), 'mask'], undefined, `${at}/mask`);
    const attn = node('Softmax', [scores], [{ name: 'axis', i: -1 }], `${at}/Softmax`);
    const mixed = node('MatMul', [attn, repeated(values(), `${at}/v`)], undefined, `${at}/av`);
    const merged = reshape(transpose(mixed, [0, 2, 1, 3], `${at}/o/Transpose`), 'out_shape', `${at}/o/Reshape`);
    h = node('Add', [h, node('MatMul', [merged, weight(`${at}.o`)], undefined, `${at}/o_proj`)], undefined, `${at}/residual`);
    // The MLP.
    const y = rmsNorm(h, weight(`${at}.post_norm`), `${at}/post_norm`);
    const up = node('MatMul', [y, weight(`${at}.up`)], undefined, `${at}/up_proj`);
    const gate = node('MatMul', [y, weight(`${at}.gate`)], undefined, `${at}/gate_proj`);
    const silu = node('Mul', [gate, node('Sigmoid', [gate], undefined, `${at}/Sigmoid`)], undefined, `${at}/silu`);
    h = node('Add', [h, node('MatMul', [node('Mul', [silu, up], undefined, `${at}/Mul`), weight(`${at}.down`)], undefined, `${at}/down_proj`)], undefined, `${at}/residual`);
  }
  if (scoring) {
    inits.push(int64s('scores_shape', [1, S]));
    const normed = rmsNorm(h, weight('norm'), 'norm');
    const s = node('MatMul', [normed, weight('score')], undefined, 'score');
    nodes.push({ op: 'Reshape', name: 'scores', inputs: [s, 'scores_shape'], outputs: ['scores'], attrs: [{ name: 'allowzero', i: 0 }] });
  } else {
    nodes.push({ op: 'Concat', name: 'kv', inputs: kv, outputs: ['kv'], attrs: [{ name: 'axis', i: 0 }] });
  }
  // Each initializer once (the shared constants were added once; a weight is named once).
  const seen = new Set<string>();
  const initializers = inits.filter((t) => !seen.has(t.name) && !!seen.add(t.name));
  return {
    name: scoring ? `qwen3-reranker-s${S}` : 'qwen3-reranker-start',
    nodes,
    initializers,
    inputs: [{ name: 'inputs_embeds', type: FLOAT, dims: [1, S, HIDDEN] }],
    outputs: scoring ? [{ name: 'scores', type: FLOAT, dims: [1, S] }] : [{ name: 'kv', type: FLOAT, dims: [LAYERS * 2, KV_HEADS, S, HEAD] }],
  };
}

/** A graph's model file's bytes (ONNX opset 17, as the trial's). */
export const graphBytes = (g: OnnxGraph): Uint8Array => onnxModel(g, { opset: 17, producer: 'manor-kit' });
