#!/usr/bin/env node
/**
 * Works out the kit from the hires, by comparison:
 *
 *   node tools/kit-from.ts --from <dir>,<dir>,...            what the hires share, and what they don't
 *   node tools/kit-from.ts --from ... --write                and lay the shared files out as the kit, in kit\
 *
 * A kit file is one that is the same in every hire once CRLF is made LF. Each is written where the kit keeps
 * it: src\<f> as kit\src\<f> (a hire's src\kit\<f>), tools\release.ts as kit\src\release.ts, and test\<f> as
 * kit\test\<f>, which runs against the fixture agent in kit\test\fixture. Their relative imports are written
 * again for their new places (src/relocate.ts). Options:
 *
 *   --overlay <path>=<file>,...   take that file's text for a kit file (a newer copy kept elsewhere)
 *   --promote <path>,...          files the same in every hire but for the agent's name: written with the
 *                                 fixture's name (default test/kit.test.ts,test/npu-queue.test.ts)
 *   --kit <dir>                   the kit tree to write (default kit\ beside this tools\ folder)
 *
 * Kit 1.0.0 was seeded from the eight hires' release-0.3.1 trees (the README has the command); later
 * changes are made in kit\ itself, so after that this is for looking, without --write.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareTrees, withoutName, type Tree } from '../src/compare.ts';
import { filesUnder, FIXTURE_DIR, lf, newPathOfOld } from '../src/kitfiles.ts';
import { norm, relocate } from '../src/relocate.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE_ID = 'fixture';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const dirs = list(opt('--from'));
if (!dirs.length) {
  console.error('kit-from: name the hires\' trees: --from <dir>,<dir>,...');
  process.exit(2);
}
const kitDir = path.resolve(opt('--kit') ?? path.join(root, 'kit'));
const overlays = new Map(list(opt('--overlay')).map((o) => [norm(o.slice(0, o.indexOf('='))), o.slice(o.indexOf('=') + 1)] as [string, string]));
const promote = list(opt('--promote') ?? 'test/kit.test.ts,test/npu-queue.test.ts').map(norm);

const trees: Tree[] = dirs.map((d) => {
  const id = JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8')).name as string;
  const files = new Map(filesUnder(d).map((f) => [f, lf(readFileSync(path.join(d, f), 'utf8'))] as [string, string]));
  return { id, files };
});
const c = compareTrees(trees);

const show = (title: string, items: string[]) => console.log(`${title} (${items.length}):${items.length ? `\n  ${items.join('\n  ')}` : ' none'}`);
console.log(`Compared ${trees.length} hires: ${trees.map((t) => t.id).join(', ')}\n`);
show('The same in every hire (kit files)', c.kit);
show("The same but for the agent's name", c.sameButName);
show('Near-identical', c.near.map((n) => `${n.path}: the same in ${n.same.length} of ${trees.length}; ${n.differ.join(', ')} differ`));
show('The same in every hire, but the project\'s own (kept per agent)', c.project);
console.log(`Per agent: ${c.perAgent.length} files`);

if (!args.includes('--write')) process.exit(0);

/**
 * Where each file goes, in the Steward repo's terms: a kit src file is laid out for a hire (src/kit/<f>) and
 * kept at kit/src/<f>; a kit test sits in kit/test and reaches the fixture's files under kit/test/fixture.
 */
const fixture = `kit/${FIXTURE_DIR}`;
const inHire = (p: string) => newPathOfOld(p) ?? p;
function place(old: string): { at: string; text: (t: string) => string } {
  const hireNew = newPathOfOld(old);
  if (hireNew) {
    // As it will sit in a hire, its imports of other kit files stay beside it and the agent's own go up a level.
    return { at: `kit/src/${hireNew.slice('src/kit/'.length)}`, text: (t) => relocate(t, old, hireNew, inHire).text };
  }
  if (old.startsWith('test/')) {
    // As if it sat in the fixture's test folder, moved up beside it: kit/test/<f>.
    const isAt = `kit/${old}`;
    const move = (target: string) => {
      const inFixture = target.startsWith(`${fixture}/`) ? target.slice(fixture.length + 1) : null;
      if (inFixture === null) return target;
      if (inFixture.startsWith('test/')) return `kit/${inFixture}`;
      return `${fixture}/${inHire(inFixture)}`;
    };
    return { at: isAt, text: (t) => relocate(t, `${fixture}/${old}`, isAt, move).text };
  }
  throw new Error(`${old}: not a kit file the kit has a place for`);
}

const written: string[] = [];
const write = (old: string, text: string) => {
  const p = place(old);
  const file = path.join(kitDir, p.at.slice('kit/'.length));
  mkdirSync(path.dirname(file), { recursive: true });
  const next = p.text(text);
  const before = existsSync(file) ? lf(readFileSync(file, 'utf8')) : null;
  if (before !== next) {
    writeFileSync(file, next);
    written.push(p.at);
  }
};

for (const f of c.kit) write(f, overlays.has(f) ? lf(readFileSync(overlays.get(f)!, 'utf8')) : trees[0].files.get(f)!);
for (const f of promote) {
  if (!c.sameButName.includes(f)) {
    console.error(`--promote ${f}: it isn't the same in every hire but for the name, so it was left out`);
    continue;
  }
  // The neutral text, with the fixture's name where each hire had its own.
  const neutral = withoutName(trees[0].files.get(f)!, trees[0].id);
  write(f, neutral.replace(/<ID>/g, FIXTURE_ID.toUpperCase()).replace(/<id>/g, FIXTURE_ID));
}
for (const [f] of overlays) if (!c.kit.includes(f)) console.error(`--overlay ${f}: not a kit file, so it was left out`);
console.log(`\n${written.length ? `Wrote ${written.length} files:\n  ${written.join('\n  ')}` : 'kit\\ already has them all.'}`);
