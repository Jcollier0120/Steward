import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

// The fake Steward repository the whole suite is tested on (wholesuite.test.ts, wholesuite-beside.test.ts), one for each
// test file: its scripts only note what ran, its tests failing while a flag file is there. The kit is tried on the agents
// at main first (stages/trial.ts: here, none), and the Steward's version is released on the team's vouch on main's head
// (stages/mainbuild.ts: gh says the team vouched), as in self.test.ts. Nothing reaches GitHub, the live ~/.steward or the
// real checkout. Imported before anything of src/, as it sets STEWARD_HOME.
export const home = mkdtempSync(path.join(os.tmpdir(), 'steward-whole-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { ctxFor, ok, runner, sh } = await import('./helpers.ts');

const dir = path.join(home, 'steward');
const origin = path.join(dir, 'origin.git');
export const checkout = path.join(dir, 'Steward');
export const ran = path.join(home, 'ran.txt');
export const failTests = path.join(home, 'fail-tests');
const URL = 'https://github.com/Jcollier0120/Steward.git';
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
sh(dir, 'init', '--quiet', '-b', 'main', checkout);
for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false', [`url.${origin.replace(/\\/g, '/')}.insteadOf`]: URL })) sh(checkout, 'config', k, v);
sh(checkout, 'remote', 'add', 'origin', URL);
export const note = (what: string, fail?: string) =>
  `const fs = require('fs');\nfs.appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(what)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n${fail ? `if (fs.existsSync(${JSON.stringify(fail)})) process.exit(1);\n` : ''}`;
const scripts = { kit: 'node tools/kit.ts --from kit', typecheck: 'node tools/typecheck.js', test: 'node tools/test.js', release: 'node tools/release.js' };
const files: Record<string, string> = {
  '.gitignore': 'node_modules/\nartifacts/\nsrc/kit/\n',
  'kit/VERSION': '1.1.0\n',
  'package.json': JSON.stringify({ name: 'steward', version: '0.9.0', type: 'commonjs', scripts }, null, 2),
  'tools/kit.ts': note('fill'),
  'tools/kit-release.ts': note('kit-release'),
  'tools/release.js': note('release'),
  'tools/typecheck.js': note('typecheck'),
  'tools/test.js': note('test', failTests),
};
for (const [f, t] of Object.entries(files)) {
  mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true });
  writeFileSync(path.join(checkout, f), t);
}
sh(checkout, 'add', '-A');
sh(checkout, 'commit', '--quiet', '-m', 'Steward 0.9.0, kit 1.1.0');
sh(checkout, 'push', '--quiet', 'origin', 'main');
export const head = () => sh(origin, 'rev-parse', 'main');
export const commit = (file: string, text: string) => {
  writeFileSync(path.join(checkout, file), text);
  sh(checkout, 'add', file);
  sh(checkout, 'commit', '--quiet', '-m', file);
  sh(checkout, 'push', '--quiet', 'origin', 'main');
};

/** A commit's statuses on GitHub: the team's vouch on each (stages/vouch.ts), so main's head isn't tested again before the Steward's release. */
const statuses = (a: string[]) => a[0] === 'api' && /\/statuses\b/.test(a[1] ?? '');
const VOUCHED = [{ context: VOUCH_CONTEXT, state: 'success', creator: { login: 'Jcollier0120' } }];
export const r = runner((a) => (statuses(a) ? ok(VOUCHED) : undefined));
export const ctx = ctxFor({ employees: [], workRoot: path.join(home, 'work'), run: r.run, neutralDir: home });
export const lines = () => (existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n').map((l) => l.trim()) : []);
export const facts = (tags: string[]) => ({ checkout, main: { head: head(), kit: '1.1.0', version: '0.9.0' }, tags });
export const tree = () => sh(checkout, 'rev-parse', 'HEAD^{tree}');
