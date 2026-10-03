// The kit's core: every rule the agents share, written once, in plain JavaScript (ES2022), with no I/O
// and no clock or randomness of its own. A driver does the reading, writing and waiting, and hands the
// core what it saw: the node part (TypeScript, for the Node agents) and the dotnet part (C#, running
// this in Jint, for Heiward). The timings and limits are data, the spec part's rules.json, which a
// driver checks with checkRules and passes in.

export * from './rules.js';
export * from './ids.js';
export * from './messages.js';
export * from './queue.js';
export * from './turn.js';
export * from './accelerators.js';
