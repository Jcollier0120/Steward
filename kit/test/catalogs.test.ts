import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

// Castellan's catalogs (catalogs.ts, kit 2.108.0): which of the kit's signed catalogs Windows should hold for a route,
// the one administrator prompt that changes it, and the catalog test. Never this PC's own database or prompt: each test
// gives its catalogs, its files and a runner that stands in for the prompt.
const { catalogChange, catalogsSay, catalogTest, catalogTestSay, changeSteps, ensureCatalogs, helperCommand, installedCatalogs, OURS, parseHelper, routeOf } = await import('./fixture/src/kit/catalogs.ts');

const body = Buffer.from('a signed catalog');
const pin = (file: string, b = body) => ({ serverVersion: '1.0.7', file, size: b.length, sha256: createHash('sha256').update(b).digest('hex'), covers: "FastFlowLM 1.0.7's 23 program files" });
const FLM = pin('castellan-amd-fastflowlm-1.0.7.cat');
const KIT = 'C:\\agent\\src\\kit\\catalogs';
const HELPER = "C:\\Users\\O'Neil\\.manor\\kit\\catalog-0123456789ab.signed.exe";

test("Castellan's catalogs by name: castellan-<route>-…; the route they're for; only they are read from Windows' database", () => {
  assert.ok(OURS.test('castellan-amd-fastflowlm-1.0.7.cat'));
  assert.ok(!OURS.test('Microsoft-Windows-Client-Features-Package.cat'));
  assert.ok(!OURS.test('castellan-..\\x.cat'));
  assert.equal(routeOf('Castellan-AMD-fastflowlm-1.0.10.cat'), 'amd');
  assert.equal(routeOf('oem12.cat'), null);
  assert.deepEqual(installedCatalogs('C:\\Windows\\System32\\CatRoot\\x', () => ['oem1.cat', 'castellan-qualcomm-geniex-0.9.1.cat', 'castellan-amd-fastflowlm-1.0.7.cat', 'castellan-amd.txt']), ['castellan-amd-fastflowlm-1.0.7.cat', 'castellan-qualcomm-geniex-0.9.1.cat']);
  assert.deepEqual(
    installedCatalogs('x', () => {
      throw new Error('EACCES');
    }),
    [],
  );
});

test("the change: each wanted catalog Windows lacks, only as it was signed; the route's older ones removed, another route's left", () => {
  const read = (f: string) => (f === `${KIT}\\${FLM.file}` ? body : null);
  const c = catalogChange([FLM], ['amd'], { installed: ['castellan-amd-fastflowlm-1.0.5.cat', 'castellan-qualcomm-geniex-0.9.1.cat'], from: KIT, read });
  assert.deepEqual(c, { add: [{ name: FLM.file, file: `${KIT}\\${FLM.file}` }], remove: ['castellan-amd-fastflowlm-1.0.5.cat'], problems: [] });
  assert.deepEqual(changeSteps(c), ['add', `${KIT}\\${FLM.file}`, 'remove', 'castellan-amd-fastflowlm-1.0.5.cat']);
  assert.deepEqual(catalogChange([FLM], ['amd'], { installed: ['CASTELLAN-AMD-FASTFLOWLM-1.0.7.CAT'], from: KIT, read }), { add: [], remove: [], problems: [] }, 'held already, whatever its case');
  assert.deepEqual(catalogChange([FLM], ['amd'], { installed: [], from: KIT, read: () => null }).problems, [`the kit has no ${FLM.file}`]);
  assert.deepEqual(catalogChange([FLM], ['amd'], { installed: [], from: KIT, read: () => Buffer.from('another catalog') }).problems, [`${FLM.file} isn't the catalog that was signed`]);
  assert.deepEqual(catalogChange([], ['amd'], { installed: ['castellan-amd-fastflowlm-1.0.7.cat'], from: KIT, read }).remove, ['castellan-amd-fastflowlm-1.0.7.cat'], 'a route that wants none any more has its own removed');
});

test("the elevated command: the helper and its steps single-quoted, an apostrophe doubled, its exit code passed on", () => {
  const cmd = helperCommand(HELPER, ['add', 'C:\\kit\\a b.cat'], 'C:\\Users\\x\\catalogs.log');
  assert.equal(cmd, `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& 'C:\\Users\\O''Neil\\.manor\\kit\\catalog-0123456789ab.signed.exe' '--log' 'C:\\Users\\x\\catalogs.log' 'add' 'C:\\kit\\a b.cat'; exit $LASTEXITCODE"`);
});

test("the helper's lines: added, removed (or gone already), loaded, blocked with its error, failed", () => {
  const said = parseHelper(['added castellan-amd-a.cat', 'not there castellan-amd-b.cat', 'removed castellan-amd-c.cat', 'loaded C:\\f\\x.dll', 'blocked C:\\f\\y z.dll 4551', 'failed add castellan-amd-d.cat 5', '']);
  assert.deepEqual(said, {
    added: ['castellan-amd-a.cat'],
    removed: ['castellan-amd-b.cat', 'castellan-amd-c.cat'],
    loaded: ['C:\\f\\x.dll'],
    blocked: [{ file: 'C:\\f\\y z.dll', error: 4551 }],
    failed: ['add castellan-amd-d.cat 5'],
  });
});

/** A runner standing in for Windows PowerShell's elevated run: it writes the helper's lines and exits with `code`. */
function elevated(code: number, lines: string[]) {
  const calls: string[][] = [];
  const files = new Map<string, string>();
  const runner = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const log = /'{1,2}--log'{1,2} '{1,2}([^']+)'{1,2}/.exec(args.join(' '))?.[1];
    if (log && code !== 1223) files.set(log, lines.join('\r\n'));
    return { code, out: '', err: '' };
  };
  return { calls, runner, read: (f: string) => files.get(f) ?? null };
}

test('setup asks Windows once where Smart App Control is on or weighing it, never where it is off, and not when every catalog is there', async () => {
  const lines: string[] = [];
  const base = { routes: ['amd'], log: (l: string) => lines.push(l), from: KIT, readCatalog: () => body, helper: HELPER, castellan: null, logFile: 'C:\\x\\catalogs.log' };
  for (const sac of ['off', null] as const) {
    const e = elevated(0, []);
    const d = await ensureCatalogs([FLM], { ...base, sac, installed: [], runner: e.runner, read: e.read });
    assert.equal(d.done, 'off');
    assert.equal(e.calls.length, 0, `nothing run where it is ${sac}`);
  }
  const there = elevated(0, []);
  assert.equal((await ensureCatalogs([FLM], { ...base, sac: 'on', installed: [FLM.file], runner: there.runner, read: there.read })).done, 'there');
  assert.equal(there.calls.length, 0);

  const e = elevated(0, [`added ${FLM.file}`, 'removed castellan-amd-fastflowlm-1.0.5.cat']);
  const d = await ensureCatalogs([FLM], { ...base, sac: 'evaluation', installed: ['castellan-amd-fastflowlm-1.0.5.cat'], runner: e.runner, read: e.read });
  assert.deepEqual(d, { done: 'changed', added: [FLM.file], removed: ['castellan-amd-fastflowlm-1.0.5.cat'], problems: [] });
  assert.equal(e.calls.length, 1, 'one prompt for both');
  assert.match(e.calls[0].at(-1)!, /Start-Process -FilePath \$f -Verb RunAs/);
  assert.match(e.calls[0].at(-1)!, /''add'' ''C:\\agent\\src\\kit\\catalogs\\castellan-amd-fastflowlm-1\.0\.7\.cat'' ''remove'' ''castellan-amd-fastflowlm-1\.0\.5\.cat''/);
  assert.match(lines[0], /^Windows asks once for an administrator, to add Castellan's signed list of FastFlowLM 1\.0\.7's 23 program files to its catalogs, so Smart App Control lets them run$/);
  assert.equal(catalogsSay(d), `Castellan's catalogs: added ${FLM.file}; removed castellan-amd-fastflowlm-1.0.5.cat`);

  const no = elevated(1223, []);
  const declined = await ensureCatalogs([FLM], { ...base, sac: 'on', installed: [], runner: no.runner, read: no.read });
  assert.equal(declined.done, 'declined');
  assert.match(catalogsSay(declined)!, /^Castellan's catalogs weren't added: the administrator prompt was turned down or couldn't open\. Smart App Control may block the server's files$/);

  const bad = elevated(5, [`failed add ${FLM.file} 5`]);
  assert.deepEqual((await ensureCatalogs([FLM], { ...base, sac: 'on', installed: [], runner: bad.runner, read: bad.read })).problems, [`couldn't add ${FLM.file} 5`]);

  const none = elevated(0, []);
  const noHelper = await ensureCatalogs([FLM], { ...base, helper: null, sac: 'on', installed: [], runner: none.runner, read: none.read });
  assert.equal(noHelper.done, 'no-helper');
  assert.equal(none.calls.length, 0, 'no prompt without the signed helper');
  assert.equal((await ensureCatalogs([FLM], { ...base, readCatalog: () => null, sac: 'on', installed: [], runner: none.runner })).done, 'not-in-kit');
});

test("the catalog test: the folder's blocked files load once the catalog is in, and it's removed again; nothing blocked can't tell", async () => {
  const folder = 'C:\\t\\fastflowlm';
  const files = [`${folder}\\flm.exe`, `${folder}\\q4nx.dll`, `${folder}\\notes.txt`];
  const run = (withCatalog: string[], code = 0) => {
    const calls: string[][] = [];
    const log = new Map<string, string>();
    return {
      calls,
      read: (f: string) => log.get(f) ?? null,
      runner: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        if (cmd === HELPER) return { code: 0, out: args.filter((_, i) => i % 2 === 1).map((f) => (/q4nx/.test(f) ? `blocked ${f} 4551` : `loaded ${f}`)).join('\r\n'), err: '' };
        const l = /'{1,2}--log'{1,2} '{1,2}([^']+)'{1,2}/.exec(args.join(' '))?.[1];
        if (l) log.set(l, withCatalog.join('\r\n'));
        return { code, out: '', err: '' };
      },
    };
  };
  const blocks = async () => [{ file: '\\Device\\HarddiskVolume3\\t\\fastflowlm\\q4nx.dll', policy: 'VerifiedAndReputableDesktop' }];
  const opts = { helper: HELPER, castellan: null, logFile: 'C:\\x\\t.log', list: () => files, blocks, now: () => 0 };
  const ok = run([`added castellan-amd-fastflowlm-1.0.7.cat`, `loaded ${folder}\\q4nx.dll`, `removed castellan-amd-fastflowlm-1.0.7.cat`]);
  const t = await catalogTest('C:\\cats\\castellan-amd-fastflowlm-1.0.7.cat', folder, { ...opts, runner: ok.runner, read: ok.read });
  assert.equal(t.ok, true, t.why ?? '');
  assert.deepEqual(t.blockedBefore, [`${folder}\\q4nx.dll`]);
  assert.deepEqual(ok.calls[0], [HELPER, 'load', `${folder}\\flm.exe`, 'load', `${folder}\\q4nx.dll`], 'program files only, unelevated');
  assert.match(ok.calls[1].at(-1)!, /''add'' ''C:\\cats\\castellan-amd-fastflowlm-1\.0\.7\.cat'' ''load'' ''C:\\t\\fastflowlm\\q4nx\.dll'' ''30'' ''remove'' ''castellan-amd-fastflowlm-1\.0\.7\.cat''/);
  const say = catalogTestSay(t, 'castellan-amd-fastflowlm-1.0.7.cat');
  assert.equal(say[0], 'Catalog test of castellan-amd-fastflowlm-1.0.7.cat: PASSED');
  assert.ok(say.includes('  the Code Integrity log: 1 of them blocked by VerifiedAndReputableDesktop'));

  const still = run([`added castellan-amd-fastflowlm-1.0.7.cat`, `blocked ${folder}\\q4nx.dll 4551`, `removed castellan-amd-fastflowlm-1.0.7.cat`]);
  const t2 = await catalogTest('C:\\cats\\castellan-amd-fastflowlm-1.0.7.cat', folder, { ...opts, runner: still.runner, read: still.read });
  assert.equal(t2.ok, false);
  assert.equal(t2.why, `with the catalog installed, Windows still blocked ${folder}\\q4nx.dll`);

  const left = run([`added castellan-amd-fastflowlm-1.0.7.cat`, `loaded ${folder}\\q4nx.dll`, 'failed remove castellan-amd-fastflowlm-1.0.7.cat 5'], 5);
  assert.match((await catalogTest('C:\\cats\\castellan-amd-fastflowlm-1.0.7.cat', folder, { ...opts, runner: left.runner, read: left.read })).why!, /^the catalog was left installed/);

  const open = run([]);
  const t3 = await catalogTest('C:\\cats\\x.cat', folder, { ...opts, list: () => [`${folder}\\flm.exe`], runner: open.runner, read: open.read });
  assert.match(t3.why!, /blocked none of .*'s 1 program files here, so the test can't tell$/);
  assert.equal(open.calls.length, 1, 'no prompt when nothing is blocked');
});
