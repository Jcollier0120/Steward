import assert from 'node:assert/strict';
import { test } from 'node:test';

// kit 2.37.0: every agent of Castellan's (a releases repository) but Heiward is published to the Exchequer and its own
// repository, never the public releases repository, for sale or held back; Heiward to the releases repository, and
// anyone else's agent to its own. Nothing here reaches GitHub or the internet: gh's calls and the Exchequer's are
// fakes, and saleOf is handed its own fetch.
const { publishTo } = await import('./fixture/src/kit/release.ts');
const { saleOf, reachedExchequer } = await import('./fixture/src/kit/exchequer.ts');
type Outcome = Awaited<ReturnType<typeof import('./fixture/src/kit/exchequer.ts').publishToExchequer>>;

const RELEASES = 'Someone/Releases';
const OWN = 'Someone/porter';
const PUBLISHED: Outcome = { ok: true, outcome: 'published', line: 'Published to the Exchequer: porter-v1.2.3 (Porter-1.2.3.zip, SHA256SUMS.txt).' };
const FAILED: Outcome = { ok: false, outcome: 'failed', line: 'Not published to the Exchequer: couldn\'t reach it. The GitHub release stands; npm run release -- --exchequer finishes it.' };

/** gh and the Exchequer, faked: what is on GitHub already, what the Exchequer says, and everything asked of them. */
function steps(o: { exchequer?: Outcome; there?: string[]; createFails?: string[]; noKey?: boolean } = {}) {
  const there = new Set(o.there ?? []);
  const calls: string[] = [];
  const lines: string[] = [];
  return {
    calls,
    lines,
    s: {
      released: (tag: string, repo: string) => {
        calls.push(`view ${repo} ${tag}`);
        return there.has(`${repo} ${tag}`) ? ('there' as const) : ('none' as const);
      },
      create: (tag: string, repo: string, own: boolean) => {
        calls.push(`create ${repo} ${tag}${own ? ' at the commit' : ''}`);
        return o.createFails?.includes(`${repo} ${tag}`) ? 1 : 0;
      },
      keyMissing: () => (o.noKey ? 'C:\\Users\\someone\\.steward\\exchequer-publisher.key' : null),
      exchequer: async () => {
        calls.push('exchequer');
        return o.exchequer ?? PUBLISHED;
      },
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(`error: ${line}`),
    },
  };
}

const porter = { id: 'porter', version: '1.2.3', repo: OWN, releasesRepo: RELEASES };

test("Castellan's agent (for sale or held back): the Exchequer first, then its own repository; never the public releases repository", async () => {
  for (const id of ['porter', 'steward', 'manor']) {
    const t = steps();
    assert.equal(await publishTo({ ...porter, id }, t.s), 0);
    assert.deepEqual(t.calls, [`view ${OWN} v1.2.3`, 'exchequer', `create ${OWN} v1.2.3 at the commit`]);
    assert.ok(!t.calls.some((c) => c.includes(RELEASES)));
    assert.ok(t.lines.some((l) => l === `${id}-v1.2.3 isn't published to ${RELEASES}: the Exchequer serves it, and nothing of Castellan's but Heiward is public.`));
  }
});

test('the Exchequer has it already (a release run again): its own repository, and still not the releases repository', async () => {
  const t = steps({ exchequer: { ok: true, outcome: 'already', line: 'The Exchequer has porter-v1.2.3 published already.' } });
  assert.equal(await publishTo(porter, t.s), 0);
  assert.deepEqual(t.calls, [`view ${OWN} v1.2.3`, 'exchequer', `create ${OWN} v1.2.3 at the commit`]);
});

test("the Exchequer doesn't take it: its own repository has it (for --exchequer), never the releases repository, and the release fails", async () => {
  for (const out of [FAILED, { ok: true, outcome: 'no-key', line: 'Not published to the Exchequer: no publisher key.' } as Outcome, { ok: true, outcome: 'not-sold', line: "isn't one of the agents it sells" } as Outcome]) {
    const t = steps({ exchequer: out });
    assert.equal(await publishTo(porter, t.s), 1);
    // The Exchequer is asked once; the files go to the agent's own repository, from where --exchequer finishes it.
    assert.deepEqual(t.calls, [`view ${OWN} v1.2.3`, 'exchequer', `create ${OWN} v1.2.3 at the commit`]);
    assert.ok(t.lines.includes(`error: Not published to the Exchequer: porter-v1.2.3 is in ${OWN} only, and Manor looks for it at the Exchequer alone: npm run release -- --exchequer finishes it.`));
  }
});

test("the agent's own repository has the version: refused before anything is published", async () => {
  const t = steps({ there: [`${OWN} v1.2.3`] });
  assert.equal(await publishTo(porter, t.s), 1);
  assert.deepEqual(t.calls, [`view ${OWN} v1.2.3`]);
  assert.match(t.lines.at(-1)!, /^error: Not published: Someone\/porter already has v1\.2\.3\. .*--exchequer/);
});

test('its own repository refusing the release fails it, after the Exchequer took it', async () => {
  const t = steps({ createFails: [`${OWN} v1.2.3`] });
  assert.equal(await publishTo(porter, t.s), 1);
  assert.ok(!t.calls.some((c) => c.includes(RELEASES)));
});

test('Heiward, public: the releases repository, its own, then the Exchequer (which never takes it)', async () => {
  const t = steps({ exchequer: { ok: true, outcome: 'not-sold', line: "The Exchequer: heiward isn't sold there." } });
  assert.equal(await publishTo({ ...porter, id: 'heiward' }, t.s), 0);
  assert.deepEqual(t.calls, [`view ${OWN} v1.2.3`, `view ${RELEASES} heiward-v1.2.3`, `create ${RELEASES} heiward-v1.2.3`, `create ${OWN} v1.2.3 at the commit`, 'exchequer']);
  const refused = steps({ there: [`${RELEASES} heiward-v1.2.3`] });
  assert.equal(await publishTo({ ...porter, id: 'heiward' }, refused.s), 1);
  const older = steps({ there: [`${OWN} v1.2.3`] });
  assert.equal(await publishTo({ ...porter, id: 'heiward' }, older.s), 0);
  assert.deepEqual(older.calls, [`view ${OWN} v1.2.3`, `view ${RELEASES} heiward-v1.2.3`, `create ${RELEASES} heiward-v1.2.3`, 'exchequer']);
});

test("no releases repository (anyone else's agent): the own repository, then the Exchequer", async () => {
  const t = steps();
  assert.equal(await publishTo({ ...porter, releasesRepo: null }, t.s), 0);
  assert.deepEqual(t.calls, [`view ${OWN} v1.2.3`, `create ${OWN} v1.2.3 at the commit`, 'exchequer']);
  const there = steps({ there: [`${OWN} v1.2.3`] });
  assert.equal(await publishTo({ ...porter, releasesRepo: null }, there.s), 1);
});

// kit 2.36.0: a release of Castellan's (with a releases repository) publishes nothing on a PC without the key.

test("no publisher key here: a release of Castellan's publishes nothing, Manor's included", async () => {
  for (const id of ['porter', 'steward', 'manor']) {
    const t = steps({ noKey: true });
    assert.equal(await publishTo({ ...porter, id }, t.s), 1);
    assert.deepEqual(t.calls, []);
    assert.equal(t.lines.length, 1);
    assert.ok(t.lines[0]!.startsWith(`error: Not published: ${id}-v1.2.3 is Castellan's, and its releases go through the Exchequer, but this PC has no publisher key (`));
    assert.ok(t.lines[0]!.endsWith('exchequer-publisher.key, or EXCHEQUER_PUBLISHER_KEY). Only the PC that releases Castellan publishes them.'));
  }
});

test('no publisher key here: Heiward, public, publishes to GitHub as before', async () => {
  const t = steps({ noKey: true });
  assert.equal(await publishTo({ ...porter, id: 'heiward' }, t.s), 0);
  assert.ok(t.calls.includes(`create ${RELEASES} heiward-v1.2.3`));
});

test("no publisher key here, and no releases repository (anyone else's agent): its own repository as before", async () => {
  const t = steps({ noKey: true });
  assert.equal(await publishTo({ ...porter, releasesRepo: null }, t.s), 0);
  assert.deepEqual(t.calls, [`view ${OWN} v1.2.3`, `create ${OWN} v1.2.3 at the commit`, 'exchequer']);
});

// saleOf: what the Exchequer's public agents list says, read as the rules above need.

const answer = (status: number, body: unknown) => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const env = { EXCHEQUER_URL: 'http://exchequer.test' };

test("saleOf reads forSale from the Exchequer's agents list", async () => {
  const agents = { agents: [{ id: 'porter', tier: 'household', forSale: true }, { id: 'steward', tier: 'workshop', forSale: false }] };
  assert.equal((await saleOf('porter', { env, fetch: answer(200, agents) })).forSale, true);
  assert.equal((await saleOf('steward', { env, fetch: answer(200, agents) })).forSale, false);
  // One the Exchequer doesn't list isn't sold there: GitHub, as before.
  assert.equal((await saleOf('someones-agent', { env, fetch: answer(200, agents) })).forSale, false);
});

test("saleOf is unsure (null) when the Exchequer can't say: an older Exchequer, an error, no answer", async () => {
  // An Exchequer from before 0.6.0, or one whose database has no for_sale yet: no forSale at all.
  const old = await saleOf('porter', { env, fetch: answer(200, { agents: [{ id: 'porter', tier: 'household' }] }) });
  assert.equal(old.forSale, null);
  assert.match(old.line, /goes to GitHub as before/);
  assert.equal((await saleOf('porter', { env, fetch: answer(200, { agents: [{ id: 'porter', tier: 'household', forSale: 'yes' }] }) })).forSale, null);
  assert.equal((await saleOf('porter', { env, fetch: answer(503, { error: 'unavailable', message: "The Exchequer's database didn't answer." }) })).forSale, null);
  assert.equal((await saleOf('porter', { env, fetch: answer(200, 'not json') })).forSale, null);
  assert.equal((await saleOf('porter', { env, fetch: answer(200, { nothing: true }) })).forSale, null);
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.equal((await saleOf('porter', { env, fetch: down })).forSale, null);
});

test('saleOf never asks about Heiward: it is never sold there', async () => {
  let asked = false;
  const spy = (async () => {
    asked = true;
    return new Response('{}');
  }) as unknown as typeof fetch;
  assert.equal((await saleOf('heiward', { env, fetch: spy })).forSale, false);
  assert.equal(asked, false);
});

test('reachedExchequer: published, or there already', () => {
  assert.equal(reachedExchequer({ outcome: 'published' }), true);
  assert.equal(reachedExchequer({ outcome: 'already' }), true);
  for (const outcome of ['not-sold', 'no-key', 'failed'] as const) assert.equal(reachedExchequer({ outcome }), false);
});
