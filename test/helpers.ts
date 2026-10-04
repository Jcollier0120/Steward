import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run as realRun, type Ran, type Runner } from '../src/run.ts';
import type { Employee, Settings } from '../src/settings.ts';
import type { Ctx } from '../src/stages/common.ts';

/** Stand-ins for the world outside the Steward: real git, a scripted gh. */

export const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const PKG = (v: string) => `{\n  "name": "fake",\n  "version": "${v}",\n  "private": true,\n  "type": "module"\n}\n`;
const LOCK = (v: string) => `{\n  "name": "fake",\n  "version": "${v}",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "fake",\n      "version": "${v}"\n    }\n  }\n}\n`;
const APP = (v: string) => `export const APP = {\n  id: 'fake',\n  name: 'Fake',\n  role: 'Stands in for a hire',\n  version: '${v}',\n};\n`;

/**
 * A fake employee: a bare "origin" with a main branch, and the person's clone of it beside it. `files`
 * are added to the first commit; `kit` writes kit.json (null for none).
 */
export function fakeEmployee(dir: string, o: { version?: string; kit?: string | null; files?: Record<string, string> } = {}): { origin: string; checkout: string } {
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
    usesKit: true,
    parts: ['node'],
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

/** A runner that answers gh from `script` (and records every call), and runs everything else for real. */
export function runner(script: GhScript = () => undefined): { run: Runner; gh: string[][] } {
  const gh: string[][] = [];
  const run: Runner = async (cmd, args, opts) => {
    if (cmd === 'gh') {
      gh.push(args);
      return script(args) ?? { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
    }
    return realRun(cmd, args, opts);
  };
  return { run, gh };
}

export const ok = (out: unknown): Ran => ({ code: 0, out: typeof out === 'string' ? out : JSON.stringify(out), err: '' });

export function ctxFor(o: { employees: Employee[]; workRoot: string; run: Runner; released?: string[]; neutralDir: string; team?: string[] }): Ctx & { lines: string[] } {
  const lines: string[] = [];
  const settings: Settings = { employees: o.employees, team: o.team ?? ['Jcollier0120'], workRoot: o.workRoot, releaseAfterMerge: false, stewardRepo: 'Jcollier0120/Steward', parallel: 2, byItself: false, roundMinutes: 10, alarms: { on: true, toast: false, waitingHours: 24, problemHours: 6, manorUrl: '', surveyorUrl: '', wrightUrl: '' }, wrightReview: { on: true, maxLines: 600, sensitive: ['jobs/**', '**/*.ps1'] }, catchUp: false, afterRelease: [] };
  return {
    settings,
    run: o.run,
    kit: { released: o.released ?? [], releasesError: null, local: null, localDir: null },
    log: (l) => lines.push(l),
    neutralDir: o.neutralDir,
    lines,
  };
}
