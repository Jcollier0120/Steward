// How every program names the accelerators (ACCELERATORS.md, "Accelerators and their ids"): the ids,
// the slug, and a graphics card's name as Heiward lists it.

/** @typedef {'npu' | 'gpu' | 'cpu'} AcceleratorKind */

/**
 * @typedef {object} AcceleratorRef Where an answer came from, as answers and notes carry it.
 * @property {string} id
 * @property {string} name
 */

/**
 * The names an older config's accelerators get, one per kind.
 * @type {Readonly<Record<AcceleratorKind, string>>}
 */
export const LEGACY_NAMES = Object.freeze({ npu: 'NPU', gpu: 'Graphics card', cpu: 'Processor' });

/**
 * The NPU an older config, and every note written before accelerators, came from.
 * @type {Readonly<AcceleratorRef>}
 */
export const LEGACY_NPU = Object.freeze({ id: 'npu', name: 'NPU' });

/**
 * A device's name as it is shown: Windows' (or DXGI's) own, (R) and (TM) taken out and its spaces collapsed, as
 * Manor shows it: "Qualcomm(R) Adreno(TM) X2-90 GPU" is "Qualcomm Adreno X2-90 GPU". Only for showing: a card's id
 * is made from its name as DXGI gives it (acceleratorId), so lock folders and configs keep theirs.
 * @param {string} name
 * @returns {string}
 */
export function deviceName(name) {
  return String(name ?? '')
    .replace(/\((R|TM)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A card's id part: its name in lowercase, each run of other characters one dash, none at either end
 * ("NVIDIA GeForce RTX 4090 #2" is "nvidia-geforce-rtx-4090-2").
 * @param {string} name
 * @returns {string}
 */
export function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `npu`, `cpu`, or `gpu-` and the slug of the card's name, `gpu-graphics-card` when that's empty.
 * @param {AcceleratorKind} kind
 * @param {string} name
 * @returns {string}
 */
export function acceleratorId(kind, name) {
  return kind === 'gpu' ? `gpu-${slug(name) || 'graphics-card'}` : kind;
}

const ID = /^(npu|cpu|gpu-[a-z0-9]+(-[a-z0-9]+)*)$/;

/**
 * Whether it is an accelerator id: npu, cpu or gpu-… (nothing that could name another folder).
 * @param {unknown} id
 * @returns {boolean}
 */
export function isId(id) {
  return typeof id === 'string' && ID.test(id);
}

/**
 * The kind an id names, or null when it isn't an id.
 * @param {unknown} id
 * @returns {AcceleratorKind | null}
 */
export function kindOfId(id) {
  if (!isId(id)) return null;
  return id === 'npu' ? 'npu' : id === 'cpu' ? 'cpu' : 'gpu';
}

/** Windows' own adapters: the Basic Render Driver, the Remote Display Adapter, Hyper-V's. */
const MICROSOFT_VENDOR = 0x1414;

/**
 * @typedef {object} DxgiAdapter One adapter as DXGI describes it. `luid` is "0x<high>_0x<low>", as the counters name it.
 * @property {number} index
 * @property {string} name
 * @property {string} luid
 * @property {number} dedicatedMemory
 * @property {number} vendorId
 * @property {boolean} software
 */

/**
 * The graphics cards as Heiward names them: Windows' software adapters left out (unless `software`), and
 * a second card of the same name (any case) "name #2", in DXGI's order. An adapter with no name is
 * "Graphics card <index + 1>".
 * @template {{ index: number, name: string, vendorId: number, software: boolean }} A
 * @param {A[]} adapters
 * @param {{ software?: boolean }} [opts]
 * @returns {(A & { key: string })[]}
 */
export function keyedCards(adapters, opts = {}) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {(A & { key: string })[]} */
  const out = [];
  for (const a of adapters) {
    if (!opts.software && (a.software || a.vendorId === MICROSOFT_VENDOR)) continue;
    const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : `Graphics card ${a.index + 1}`;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    out.push({ ...a, name, key: n === 1 ? name : `${name} #${n}` });
  }
  return out;
}
