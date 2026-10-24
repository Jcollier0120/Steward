import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { developerProForTests } from '../src/kit/developer-pro.ts';
import { gitExe } from '../src/kit/git-exe.ts';
import { makersPcForTests } from '../src/maker.ts';
import { run as realRun, type Ran, type Runner } from '../src/run.ts';
import type { Employee, Settings } from '../src/settings.ts';
import type { Ctx } from '../src/stages/common.ts';
import { DEFAULT_PIPELINE } from '../src/pipeline.ts';

/** Stand-ins for the world outside the Steward: real git, a scripted gh. */

// The Bailiff's install decides whether the Wright's drafts wait for its approval (settings.ts's bailiffInstalled): a test
// never sees this PC's. One that wants it installed sets BAILIFF_HOME itself.
process.env.BAILIFF_HOME ??= path.join(os.tmpdir(), 'steward-test-no-bailiff');
// Never this PC's Manor: off the makers' PC its Repositories are the Steward's (settings.ts manorTakesOver), and Look
// after writes into them. A test that wants a Manor makes one.
process.env.MANOR_HOME ??= path.join(os.tmpdir(), 'steward-test-no-manor');
// The same for the Wright's and the Surveyor's installs (settings.ts's wrightInstalled, surveyorInstalled): the tests see
// the owner's PC as it is, with both installed, unless one says otherwise before it imports this.
for (const [name, home] of [['WRIGHT_HOME', 'steward-test-wright'], ['SURVEYOR_HOME', 'steward-test-surveyor']] as const) {
  if (process.env[name] !== undefined) continue;
  process.env[name] = path.join(os.tmpdir(), home);
  mkdirSync(path.join(process.env[name]!, 'app'), { recursive: true });
}

// The Exchequer's publisher key (the kit's exchequer.ts) marks the PC that releases Castellan, which settings from before
// releasesCastellan are migrated to (migrate.ts): the tests see the owner's PC, with it, whatever this PC holds.
process.env.EXCHEQUER_PUBLISHER_KEY ??= 'steward-test-publisher-key';

// The maker's laptop (maker.ts, its firmware): the tests see it, wherever they run, unless one says otherwise
// (makersPcForTests(() => false), or STEWARD_CUSTOMER=1 for a child process).
makersPcForTests(() => true);
// Developer Pro (the kit's developer-pro.ts, its own check of the same firmware): the Wright's and the Bailiff's work with
// the staff is done there, so the tests see it too, unless one says otherwise (developerProForTests(() => false)). Left to
// the firmware, every other PC (WEASELDEV02, a contributor's) failed the tests that file work for the Wright.
developerProForTests(() => true);

// The real git.exe, as run.ts starts it (the kit's git-exe.ts): Git for Windows' launcher on PATH would double each one's cost.
export const sh = (cwd: string, ...args: string[]) => execFileSync(gitExe(), args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const PKG = (v: string) => `{\n  "name": "fake",\n  "version": "${v}",\n  "private": true,\n  "type": "module"\n}\n`;
const LOCK = (v: string) => `{\n  "name": "fake",\n  "version": "${v}",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "fake",\n      "version": "${v}"\n    }\n  }\n}\n`;
const APP = (v: string) => `export const APP = {\n  id: 'fake',\n  name: 'Fake',\n  role: 'Stands in for a hire',\n  version: '${v}',\n};\n`;

type FakeOptions = { version?: string; kit?: string | null; files?: Record<string, string> };

/**
 * A fake employee: a bare "origin" with a main branch, and the person's clone of it beside it. `files`
 * are added to the first commit; `kit` writes kit.json (null for none).
 *
 * Building one takes eight git commands, a second or more on Windows, and a test file makes a dozen or more: so the first
 * of each kind is built (buildFake) and kept as it was made (keepFake), and the rest are copies of it. Every copy is
 * given a first commit of its own (rootCommit), as building it afresh did: the Steward keeps what it found by commit (a
 * PR's checks, a bump's hold, a kickback), and two fake employees sharing one would hand one test's records to the next.
 */
export function fakeEmployee(dir: string, o: FakeOptions = {}): { origin: string; checkout: string } {
  const origin = path.join(dir, 'origin.git');
  const checkout = path.join(dir, 'Fake');
  const kind = JSON.stringify([o.version ?? '0.4.0', o.kit === undefined ? '1.0.0' : o.kit, o.files ?? {}]);
  const kept = fakes.get(kind);
  if (!kept) {
    buildFake(dir, o);
    if (kept === undefined) fakes.set(kind, keepFake(origin, checkout));
    return { origin, checkout };
  }
  kept.tree ??= sh(kept.checkout, 'rev-parse', 'HEAD^{tree}');
  cpSync(kept.origin, origin, { recursive: true });
  cpSync(kept.checkout, checkout, { recursive: true });
  // The clone's remote is its own origin (git writes the path with each backslash doubled).
  const config = path.join(checkout, '.git', 'config');
  const url = (p: string) => `url = ${p.replace(/\\/g, '\\\\')}\n`;
  const text = readFileSync(config, 'utf8');
  if (!text.includes(url(kept.url))) throw new Error(`fakeEmployee: no "${url(kept.url).trim()}" in the clone's .git/config to point at ${origin}`);
  writeFileSync(config, text.replace(url(kept.url), () => url(origin)));
  const sha = rootCommit([path.join(checkout, '.git'), origin], kept.tree, 'Fake 0.4.0');
  for (const ref of [path.join(origin, 'refs', 'heads', 'main'), path.join(checkout, '.git', 'refs', 'heads', 'main'), path.join(checkout, '.git', 'refs', 'remotes', 'origin', 'main')]) writeFileSync(ref, `${sha}\n`);
  // Its reflogs named the first one's commit.
  rmSync(path.join(checkout, '.git', 'logs'), { recursive: true, force: true });
  return { origin, checkout };
}

/** A fake employee as it was built, kept for fakeEmployee to copy: `url`, the origin its clone names; `tree`, its commit's. */
type KeptFake = { origin: string; checkout: string; url: string; tree?: string };
/** The first of each kind of fake employee, by its options: null for a kind built afresh each time (keepFake). */
const fakes = new Map<string, KeptFake | null>();
let fakesDir: string | undefined;
process.on('exit', () => fakesDir && rmSync(fakesDir, { recursive: true, force: true }));

/**
 * A copy of a fake employee just built, before its test changes it. Null where git keeps its refs or its ids in a way
 * rootCommit doesn't write (a ref table, SHA-256: init.defaultRefFormat, init.defaultObjectFormat), so that each one of
 * the kind is built afresh, as before.
 */
function keepFake(origin: string, checkout: string): KeptFake | null {
  const main = [path.join(origin, 'refs', 'heads', 'main'), path.join(checkout, '.git', 'refs', 'heads', 'main')];
  if (!main.every((ref) => existsSync(ref) && readFileSync(ref, 'utf8').trim().length === 40)) return null;
  // Its copies' commits come after its own.
  lastRoot = Math.max(lastRoot, Math.floor(Date.now() / 1000));
  fakesDir ??= mkdtempSync(path.join(os.tmpdir(), 'steward-test-fakes-'));
  const dir = path.join(fakesDir, String(fakes.size));
  const kept = { origin: path.join(dir, 'origin.git'), checkout: path.join(dir, 'Fake'), url: origin };
  cpSync(origin, kept.origin, { recursive: true });
  cpSync(checkout, kept.checkout, { recursive: true });
  return kept;
}

/** The time of the last first commit rootCommit wrote, in seconds. */
let lastRoot = 0;

/**
 * A first commit of `tree`, as `git commit` writes one (zlib over "commit <size>\0" and its text), put in each of
 * `gitDirs`' objects without a git process: its id. Its time is a second after the last one's at least, so two written
 * in the same second differ.
 */
function rootCommit(gitDirs: string[], tree: string, message: string): string {
  lastRoot = Math.max(Math.floor(Date.now() / 1000), lastRoot + 1);
  const who = `Test <test@example.invalid> ${lastRoot} +0000`;
  const text = `tree ${tree}\nauthor ${who}\ncommitter ${who}\n\n${message}\n`;
  const object = Buffer.from(`commit ${Buffer.byteLength(text)}\0${text}`);
  const sha = createHash('sha1').update(object).digest('hex');
  for (const g of gitDirs) {
    mkdirSync(path.join(g, 'objects', sha.slice(0, 2)), { recursive: true });
    writeFileSync(path.join(g, 'objects', sha.slice(0, 2), sha.slice(2)), deflateSync(object));
  }
  return sha;
}

/** A fake employee built with git, as fakeEmployee describes. */
function buildFake(dir: string, o: FakeOptions): { origin: string; checkout: string } {
  const origin = path.join(dir, 'origin.git');
  const checkout = path.join(dir, 'Fake');
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  sh(dir, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  const v = o.version ?? '0.4.0';
  const files: Record<string, string> = {
    'package.json': PKG(v),
    'package-lock.json': LOCK(v),
    'src/app.ts': APP(v),
    '.gitignore': 'node_modules/\nsrc/kit/\n',
    ...(o.kit === null ? {} : { 'kit.json': `{\n  "kit": "${o.kit ?? '1.0.0'}",\n  "parts": ["node"]\n}\n` }),
    ...o.files,
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true });
    writeFileSync(path.join(checkout, f), t);
  }
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Fake 0.4.0');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  return { origin, checkout };
}

export function employee(checkout: string, more: Partial<Employee> = {}): Employee {
  return {
    id: 'fake',
    name: 'Fake',
    repo: 'Jcollier0120/Fake',
    checkout,
    branch: 'main',
    merges: true,
    usesKit: true,
    fill: 'node tools/kit.ts',
    test: ['node -e process.exit(0)'],
    versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'],
    release: 'node -e process.exit(0)',
    install: 'node src/cli.ts install',
    approve: '',
    installed: '',
    ...more,
  };
}

export type GhScript = (args: string[]) => Ran | undefined;

/**
 * A runner that answers gh from `script` (and records every call), and runs everything else for real. A description
 * written to a file (--body-file, removed once gh has read it) is recorded as its text, in place of the file's path.
 */
export function runner(script: GhScript = () => undefined): { run: Runner; gh: string[][] } {
  const gh: string[][] = [];
  const run: Runner = async (cmd, args, opts) => {
    if (cmd === 'gh') {
      const i = args.indexOf('--body-file');
      gh.push(i >= 0 ? args.map((a, j) => (j === i + 1 ? readFileSync(a, 'utf8') : a)) : args);
      return script(args) ?? { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
    }
    return realRun(cmd, args, opts);
  };
  return { run, gh };
}

/** The gh pr merge commands run, without the head commit each names (--match-head-commit <sha>: the fixtures' commits differ each run). */
export const mergesOf = (gh: string[][]) => gh.filter((a) => a[1] === 'merge').map((a) => a.filter((x, i) => x !== '--match-head-commit' && a[i - 1] !== '--match-head-commit'));

export const ok = (out: unknown): Ran => ({ code: 0, out: typeof out === 'string' ? out : JSON.stringify(out), err: '' });

export function ctxFor(o: { employees: Employee[]; workRoot: string; run: Runner; released?: string[]; neutralDir: string; team?: string[] }): Ctx & { lines: string[] } {
  const lines: string[] = [];
  const settings: Settings = { employees: o.employees, team: o.team ?? ['Jcollier0120'], workRoot: o.workRoot, releaseAfterMerge: false, stewardRepo: 'Jcollier0120/Steward', parallel: 2, stagesAtOnce: 2, byItself: false, roundMinutes: 10, alarms: { on: true, toast: false, waitingHours: 24, blockingHours: 1, problemHours: 6, tastingHours: 6 }, wrightReview: { on: true, maxLines: 600, sensitive: ['jobs/**', '**/*.ps1'] }, catchUp: false, mergeTrain: false, afterRelease: [], rollout: true, rolloutQuietHours: 2, rolloutMaxWaitHours: 12, buildPipeline: DEFAULT_PIPELINE, releaseSelf: true, mergeSelf: true, stewardCheckout: path.join(o.neutralDir, 'no-steward-checkout'), tasteBeforeRelease: true, fileWork: true, tend: false, releasesCastellan: true, releasesRepo: 'Jcollier0120/Manor-releases', dotnetRoot: '', sourceControl: 'auto', wrightHere: true, makersPc: true };
  return {
    settings,
    run: o.run,
    kit: { released: o.released ?? [], releasesError: null, local: null, localDir: null },
    log: (l) => lines.push(l),
    neutralDir: o.neutralDir,
    // Asking GitHub again (merge.ts) waits for nothing here.
    pause: async () => {},
    lines,
  };
}
