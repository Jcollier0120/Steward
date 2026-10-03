#!/usr/bin/env node
/**
 * Turns a hire that carries its own copy of the kit into one that takes the Steward's (src/convert.ts):
 *
 *   node tools/convert.ts <hire folder> --version <new version> [--kit <version>] [--parts node,web,spec]
 *
 * Only for the eight hires that carried the old kit (OLD_KIT_HIRES, by package.json's name): it refuses any
 * other agent, Reeve say, whose files at the old kit's paths are its own.
 *
 * Run it in a fresh worktree of the hire, never the person's own checkout. It stages its changes and
 * commits nothing: then fill the kit (node tools/kit.ts --from <the Steward's kit>), run the hire's
 * typecheck and tests, and commit. The README's "Converting a hire" has the whole round.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/convert.ts';
import { kitVersionOf } from '../src/kitfiles.ts';
import { run } from '../src/run.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [dir, ...args] = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const version = opt('--version');
if (!dir || !version) {
  console.error('Usage: node tools/convert.ts <hire folder> --version <new version> [--kit <version>] [--parts node,web,spec]');
  process.exit(2);
}
const kit = opt('--kit') ?? kitVersionOf(path.join(root, 'kit'))!;
const parts = (opt('--parts') ?? 'node,web,spec').split(',');
try {
  const r = await convert({ dir: path.resolve(dir), kit, parts, version, kitTool: readFileSync(path.join(root, 'tools', 'kit.ts'), 'utf8'), run });
  console.log(`${dir}: ${r.from} → ${version}, kit ${kit} (${parts.join(', ')})`);
  console.log(`  removed ${r.removed.length} old kit files: ${r.removed.join(', ')}`);
  console.log(`  imports rewritten in ${r.rewritten.length} files: ${r.rewritten.map((x) => `${x.file} (${x.changes.length})`).join(', ')}`);
  for (const n of r.notes) console.log(`  ${n}`);
} catch (e) {
  console.error(`convert: ${(e as Error).message}`);
  process.exitCode = 1;
}
