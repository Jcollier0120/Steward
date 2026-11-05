'use strict';
/**
 * Runs a module that a release carries as V8 bytecode, never as source (bytecode.ts, kit 2.152.0). Its .js is a
 * one-line stub that calls this; beside it is its bytecode for each processor and Node.js it was built for
 * (cli.arm64-v22.23.3.jsc). The bytecode is V8's own code cache of the module, compiled whole when the release was
 * built, so V8 takes it with a stand-in for the source it was made from, of that source's length, which is never run.
 */
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');

// V8 lets go of bytecode a function hasn't run for a while, to compile it again from source when it's next called:
// there is no source here, only the stand-in.
v8.setFlagsFromString('--no-flush-bytecode');

// Node.js calls the loader an import() in a module uses here (vm's USE_MAIN_CONTEXT_DEFAULT_LOADER: its own) experimental,
// in a warning on the first import() of each process: it would be on every agent's command line and in its logs, and
// says nothing to whoever reads them. That warning alone is let go.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning && warning.message;
  if (typeof text === 'string' && text.includes('USE_MAIN_CONTEXT_DEFAULT_LOADER')) return;
  return emitWarning.call(this, warning, ...rest);
};

/** V8's code cache, as it is laid out: its source's length at bytes 8-12 (the top bit says a module), its flags' hash at 12-16. */
const SOURCE_HASH = 8;
const FLAG_HASH = 12;

let flags = null;
/**
 * The cache is taken only by a V8 with the same flags' hash, and the build compiled every function at once
 * (--no-lazy), which this Node doesn't run with: this Node's hash goes in. It's kept, and read again (`fresh`) when V8
 * turns a cache down: code that sets a flag as it runs (v8.setFlagsFromString('--expose-gc'), as Reeve's MCP server
 * does) changes the hash.
 */
function sameFlags(data, fresh) {
  if (!flags || fresh) flags = new vm.Script('"flags"').createCachedData().subarray(FLAG_HASH, FLAG_HASH + 4);
  flags.copy(data, FLAG_HASH);
}

/**
 * The module's wrapper (Node's `function (exports, require, module, __filename, __dirname)`) from its bytecode, or
 * null when V8 turns it down. Only the bytecode gives a function: the stand-in, when V8 compiles that instead, is
 * blank and gives nothing, so what comes back is the proof. The stand-in is `fill` repeated: V8 keeps each script it
 * compiles by its source and file, so a second try with the first's stand-in would get the first's back.
 */
function wrapperOf(file, data, fill) {
  const length = data.length >= 16 ? data.readUInt32LE(SOURCE_HASH) & 0x7fffffff : 0;
  if (!length) return null;
  const script = new vm.Script(fill.repeat(length), {
    filename: file,
    cachedData: data,
    // import() in it loads as Node's own loader would, beside this file.
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  if (script.cachedDataRejected) return null;
  const wrapper = script.runInThisContext();
  return typeof wrapper === 'function' ? wrapper : null;
}

/** The Node.js builds a module has bytecode for, from the files beside it: ["arm64-v22.23.3", "x64-v22.23.3"]. */
function builtFor(file) {
  const base = `${path.basename(file, '.js')}.`;
  try {
    return readdirSync(path.dirname(file))
      .filter((n) => n.startsWith(base) && n.endsWith('.jsc'))
      .map((n) => n.slice(base.length, -4))
      .sort();
  } catch {
    return [];
  }
}

/** Why it can't run on this Node.js, in words. */
function notHere(file, why) {
  const built = builtFor(file).map((b) => {
    const [arch, version] = b.split('-');
    return `Node.js ${version} for ${arch}`;
  });
  const has = built.length ? `It runs on ${built.join(' and ')}` : 'It has no bytecode';
  return new Error(
    `${path.basename(file)} can't run here: ${why}. ${has}, and this is Node.js ${process.version} for ${process.arch}. ` +
      "Castellan's setup brings the Node.js its staff run on: run it again, and update this one.",
  );
}

/**
 * Runs `file`'s bytecode as the CommonJS module `mod` (the stub's own module, require, filename and folder), as Node
 * would run its source: `mod.exports` is what it exports.
 */
module.exports = function run(mod, req, file, dir) {
  const own = `${process.arch}-${process.version}`;
  let data;
  try {
    data = readFileSync(file.replace(/\.js$/, `.${own}.jsc`));
  } catch (e) {
    if (e && e.code === 'ENOENT') throw notHere(file, 'the release has no bytecode for this Node.js');
    throw e;
  }
  if (data.length >= 16) sameFlags(data, false);
  let wrapper = wrapperOf(file, data, ' ');
  if (!wrapper && data.length >= 16) {
    // A flag set since the last module: the hash as it is now.
    sameFlags(data, true);
    wrapper = wrapperOf(file, data, '\t');
  }
  if (!wrapper) throw notHere(file, 'this Node.js turned its bytecode down');
  wrapper.call(mod.exports, mod.exports, req, mod, file, dir);
};
