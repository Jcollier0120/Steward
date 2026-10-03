// Made by kit/test/core-types.ts from ids.js's JSDoc: don't edit it, run npm run core-types.
export type AcceleratorKind = 'npu' | 'gpu' | 'cpu';
export type AcceleratorRef = {
    id: string;
    name: string;
};
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
export declare const LEGACY_NAMES: Readonly<Record<AcceleratorKind, string>>;
/**
 * The NPU an older config, and every note written before accelerators, came from.
 * @type {Readonly<AcceleratorRef>}
 */
export declare const LEGACY_NPU: Readonly<AcceleratorRef>;
/**
 * A card's id part: its name in lowercase, each run of other characters one dash, none at either end
 * ("NVIDIA GeForce RTX 4090 #2" is "nvidia-geforce-rtx-4090-2").
 * @param {string} name
 * @returns {string}
 */
export declare function slug(name: string): string;
/**
 * `npu`, `cpu`, or `gpu-` and the slug of the card's name, `gpu-graphics-card` when that's empty.
 * @param {AcceleratorKind} kind
 * @param {string} name
 * @returns {string}
 */
export declare function acceleratorId(kind: AcceleratorKind, name: string): string;
/**
 * Whether it is an accelerator id: npu, cpu or gpu-… (nothing that could name another folder).
 * @param {unknown} id
 * @returns {boolean}
 */
export declare function isId(id: unknown): boolean;
/**
 * The kind an id names, or null when it isn't an id.
 * @param {unknown} id
 * @returns {AcceleratorKind | null}
 */
export declare function kindOfId(id: unknown): AcceleratorKind | null;
export type DxgiAdapter = {
    index: number;
    name: string;
    luid: string;
    dedicatedMemory: number;
    vendorId: number;
    software: boolean;
};
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
export declare function keyedCards<A extends {
    index: number;
    name: string;
    vendorId: number;
    software: boolean;
}>(adapters: A[], opts?: {
    software?: boolean;
}): (A & {
    key: string;
})[];
