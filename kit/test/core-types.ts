#!/usr/bin/env node
/**
 * The core's .d.ts files, for the TypeScript agents, made from its JSDoc: the core's .js are type-checked
 * (checkJs, strict) and their declarations emitted, in a scratch folder. kit/test/core.test.ts checks that
 * kit/core's .d.ts are what this makes; after changing the core, write them again:
 *
 *   npm run core-types        (node kit/test/core-types.ts --write)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const coreDir = fileURLToPath(new URL('../core/', import.meta.url));

/** The core's modules, by file name. */
export const coreModules = () => readdirSync(coreDir).filter((f) => f.endsWith('.js')).sort();

/** The .d.ts each module's JSDoc gives, by file name; throws with tsc's output when the core doesn't type-check. */
export function makeCoreTypes(): Record<string, string> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kit-core-types-'));
  try {
    for (const f of coreModules()) copyFileSync(path.join(coreDir, f), path.join(tmp, f));
    writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      path.join(tmp, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'es2022',
          lib: ['es2022'],
          module: 'nodenext',
          moduleResolution: 'nodenext',
          allowJs: true,
          checkJs: true,
          strict: true,
          declaration: true,
          emitDeclarationOnly: true,
          outDir: 'types',
          types: [],
        },
        include: ['*.js'],
      }),
    );
    const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
    try {
      execFileSync(process.execPath, [tsc, '-p', tmp], { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch (e) {
      const out = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`.replace(/[^\s(]*kit-core-types-[^\\/]+[\\/]/g, 'kit/core/');
      throw new Error(`the core doesn't type-check:\n${out.trim()}`);
    }
    const out: Record<string, string> = {};
    for (const f of coreModules()) {
      const d = f.replace(/\.js$/, '.d.ts');
      out[d] = `// Made by kit/test/core-types.ts from ${f}'s JSDoc: don't edit it, run npm run core-types.\n${readFileSync(path.join(tmp, 'types', d), 'utf8').replace(/\r\n/g, '\n')}`;
    }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const types = makeCoreTypes();
    if (process.argv.includes('--write')) {
      for (const [f, text] of Object.entries(types)) writeFileSync(path.join(coreDir, f), text);
      console.log(`kit/core: ${Object.keys(types).join(', ')} written`);
    } else {
      console.log(`kit/core type-checks; ${Object.keys(types).length} declaration files (--write writes them)`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
