import assert from 'node:assert/strict';
import { test } from 'node:test';

// kit 2.35.0: an agent the Exchequer sells is published there, and not to the public releases repository; one it
// doesn't sell, or when it can't say, goes to GitHub as before. Nothing here reaches GitHub or the internet: gh's
// calls and the Exchequer's are fakes, and saleOf is handed its own fetch.
const { publishTo } = await import('./fixture/src/kit/release.ts');
const { saleOf, reachedExchequer } = await import('./fixture/src/kit/exchequer.ts');
type Sale = Awaited<ReturnType<typeof saleOf>>;
type Outcome = Awaited<ReturnType<typeof import('./fixture/src/kit/exchequer.ts').publishToExchequer>>;

const RELEASES = 'Someone/Releases';
const OWN = 'Someone/porter';
const PUBLISHED: Outcome = { ok: true, outcome: 'published', line: 'Published to the Exchequer: porter-v1.2.3 (Porter-1.2.3.zip, SHA256SUMS.txt).' };
const FAILED: Outcome = { ok: false, outcome: 'failed', line: 'Not published to the Exchequer: couldn\'t reach it. The GitHub release stands; npm run release -- --exchequer finishes it.' };

/** gh and the Exchequer, faked: what is on GitHub already, what the Exchequer says, and everything asked of them. */
function steps(o: { sale?: Sale; exchequer?: Outcome; there?: string[]; createFails?: string[]; noKey?: boolean } = {}) {
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
      sale: async (id: string) => {
        calls.push(`sale ${id}`);
        return o.sale ?? { forSale: null, line: 'unsure' };
      },
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
const FOR_SALE: Sale = { forSale: true, line: 'The Exchequer sells porter.' };
const NOT_FOR_SALE: Sale = { forSale: false, line: "The Exchequer doesn't sell porter yet." };
const UNSURE: Sale = { forSale: null, line: "The Exchequer couldn't say." };

test('for sale: the Exchequer first, then the agent\'s own repository; never the public releases repository', async () => {
  const t = steps({ sale: FOR_SALE });
  assert.equal(await publishTo(porter, t.s), 0);
  assert.deepEqual(t.calls, ['sale porter', `view ${OWN} v1.2.3`, 'exchequer', `create ${OWN} v1.2.3 at the commit`]);
  assert.ok(!t.calls.some((c) => c.includes(RELEASES)));
  assert.ok(t.lines.some((l) => l === `porter-v1.2.3 isn't published to ${RELEASES}: the Exchequer serves it.`));
});

test('for sale, and the Exchequer has it already (a release run again): still not the releases repository', async () => {
  const t = steps({ sale: FOR_SALE, exchequer: { ok: true, outcome: 'already', line: 'The Exchequer has porter-v1.2.3 published already.' } });
  assert.equal(await publishTo(porter, t.s), 0);
  assert.deepEqual(t.calls, ['sale porter', `view ${OWN} v1.2.3`, 'exchequer', `create ${OWN} v1.2.3 at the commit`]);
});

test("for sale, but the Exchequer doesn't take it: the releases repository as before, so the release is never lost", async () => {
  for (const out of [FAILED, { ok: true, outcome: 'no-key', line: 'Not published to the Exchequer: no publisher key.' } as Outcome, { ok: true, outcome: 'not-sold', line: "isn't sold there" } as Outcome]) {
    const t = steps({ sale: FOR_SALE, exchequer: out });
    assert.equal(await publishTo(porter, t.s), 0);
    // The Exchequer is asked once: its failure is a line (the Steward's note), never a second try or a failed release.
    assert.deepEqual(t.calls, ['sale porter', `view ${OWN} v1.2.3`, 'exchequer', `create ${RELEASES} porter-v1.2.3`, `create ${OWN} v1.2.3 at the commit`]);
    assert.ok(t.lines.includes(`So porter-v1.2.3 goes to ${RELEASES} as before, where every Manor finds it.`));
  }
});

test("for sale, and the agent's own repository has the version: refused before anything is published", async () => {
  const t = steps({ sale: FOR_SALE, there: [`${OWN} v1.2.3`] });
  assert.equal(await publishTo(porter, t.s), 1);
  assert.deepEqual(t.calls, ['sale porter', `view ${OWN} v1.2.3`]);
  assert.match(t.lines.at(-1)!, /^error: Not published: Someone\/porter already has v1\.2\.3\. .*--exchequer/);
});

test("for sale: GitHub's exit code is the release's, whatever the Exchequer did", async () => {
  const t = steps({ sale: FOR_SALE, createFails: [`${OWN} v1.2.3`] });
  assert.equal(await publishTo(porter, t.s), 1);
  assert.ok(!t.calls.some((c) => c.includes(RELEASES)));
});

test('not for sale (held back, or unknown to the Exchequer): the releases repository, the own one, then the Exchequer too', async () => {
  const t = steps({ sale: NOT_FOR_SALE });
  assert.equal(await publishTo(porter, t.s), 0);
  assert.deepEqual(t.calls, ['sale porter', `view ${RELEASES} porter-v1.2.3`, `view ${OWN} v1.2.3`, `create ${RELEASES} porter-v1.2.3`, `create ${OWN} v1.2.3 at the commit`, 'exchequer']);
});

test("the Exchequer can't say (down, or from before forSale): GitHub as before, and the Exchequer after", async () => {
  const t = steps({ sale: UNSURE, exchequer: FAILED });
  assert.equal(await publishTo(porter, t.s), 0);
  assert.deepEqual(t.calls, ['sale porter', `view ${RELEASES} porter-v1.2.3`, `view ${OWN} v1.2.3`, `create ${RELEASES} porter-v1.2.3`, `create ${OWN} v1.2.3 at the commit`, 'exchequer']);
  assert.ok(t.lines.includes(`error: ${FAILED.line}`));
});

test('not for sale, as before: refused when the releases repository has it; the releases repository alone when only the own one has it', async () => {
  const refused = steps({ sale: NOT_FOR_SALE, there: [`${RELEASES} porter-v1.2.3`] });
  assert.equal(await publishTo(porter, refused.s), 1);
  assert.deepEqual(refused.calls, ['sale porter', `view ${RELEASES} porter-v1.2.3`]);
  const older = steps({ sale: NOT_FOR_SALE, there: [`${OWN} v1.2.3`] });
  assert.equal(await publishTo(porter, older.s), 0);
  assert.deepEqual(older.calls, ['sale porter', `view ${RELEASES} porter-v1.2.3`, `view ${OWN} v1.2.3`, `create ${RELEASES} porter-v1.2.3`, 'exchequer']);
});

test('no releases repository (anyone else\'s agent): the Exchequer is not asked about sale; the own repository, then the Exchequer', async () => {
  const t = steps({ sale: FOR_SALE });
  assert.equal(await publishTo({ ...porter, releasesRepo: null }, t.s), 0);
  assert.deepEqual(t.calls, [`view ${OWN} v1.2.3`, `create ${OWN} v1.2.3 at the commit`, 'exchequer']);
});

// kit 2.36.0: on 2026-10-07, 12 staff releases reached the public releases repository and never the Exchequer. They
// were published without the publisher key, by a release outside the PC that releases Castellan. A release of
// Castellan's (with a releases repository) now publishes nothing on a PC without the key.

test("no publisher key here: a staff release of Castellan's publishes nothing, whatever the Exchequer would say", async () => {
  for (const sale of [FOR_SALE, NOT_FOR_SALE, UNSURE]) {
    const t = steps({ sale, noKey: true });
    assert.equal(await publishTo(porter, t.s), 1);
    // Not GitHub, not the Exchequer: nothing is even asked.
    assert.deepEqual(t.calls, []);
    assert.equal(t.lines.length, 1);
    assert.match(t.lines[0]!, /^error: Not published: porter-v1\.2\.3 is Castellan's, and its releases go through the Exchequer, but this PC has no publisher key \(.*exchequer-publisher\.key, or EXCHEQUER_PUBLISHER_KEY\)\. Only the PC that releases Castellan publishes them\.$/);
  }
});

test('no publisher key here: the legacy releases repository (a Steward from before 0.19.0) publishes nothing either', async () => {
  const t = steps({ sale: UNSURE, noKey: true });
  assert.equal(await publishTo({ ...porter, releasesRepo: 'Jcollier0120/Manor-releases' }, t.s), 1);
  assert.deepEqual(t.calls, []);
});

test('no publisher key here: Manor and Heiward, never sold, publish to GitHub as before', async () => {
  for (const id of ['manor', 'heiward']) {
    const t = steps({ sale: NOT_FOR_SALE, noKey: true });
    assert.equal(await publishTo({ ...porter, id }, t.s), 0);
    assert.deepEqual(t.calls, [`sale ${id}`, `view ${RELEASES} ${id}-v1.2.3`, `view ${OWN} v1.2.3`, `create ${RELEASES} ${id}-v1.2.3`, `create ${OWN} v1.2.3 at the commit`, 'exchequer']);
  }
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

test('saleOf never asks about Manor or Heiward: they are never sold there', async () => {
  let asked = false;
  const spy = (async () => {
    asked = true;
    return new Response('{}');
  }) as unknown as typeof fetch;
  assert.equal((await saleOf('manor', { env, fetch: spy })).forSale, false);
  assert.equal((await saleOf('heiward', { env, fetch: spy })).forSale, false);
  assert.equal(asked, false);
});

test('an older Exchequer, end to end: a release goes to the releases repository as before', async () => {
  const t = steps();
  t.s.sale = (id: string) => saleOf(id, { env, fetch: answer(200, { agents: [{ id: 'porter', tier: 'household' }] }) });
  assert.equal(await publishTo(porter, t.s), 0);
  assert.ok(t.calls.includes(`create ${RELEASES} porter-v1.2.3`));
});

test('reachedExchequer: published, or there already', () => {
  assert.equal(reachedExchequer({ outcome: 'published' }), true);
  assert.equal(reachedExchequer({ outcome: 'already' }), true);
  for (const outcome of ['not-sold', 'no-key', 'failed'] as const) assert.equal(reachedExchequer({ outcome }), false);
});
