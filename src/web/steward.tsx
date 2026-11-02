import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ago, Badge, Card, Glance, Input, NeedsYou, Notes, Output, PageTabs, PostButton, Section, Text, useNow, type BadgeTone, type GlanceTile, type Need, type PageTab } from '../kit/react/index.ts';
import type { Alarm, AlarmState } from '../alarms.ts';
import type { TendState } from '../tend.ts';
import type { TurnRow, TurnsView } from '../lease.ts';
import type { Host } from '../scm.ts';
import type { EmployeeResult, StageResult } from '../stages/common.ts';
import type { WholeJob } from '../stages/wholesuite.ts';
import type { FoundView, PrView, RoundView, StaffRowView, StaffView, StewardView } from './types.ts';
import { askedWords } from './asked.ts';
import { commitUrl, compareUrl, kindOf, releaseUrl, repoUrl } from '../links.ts';

/**
 * The Steward's page: what needs you, the page at a glance, then its tabs: the staff (a card each), the last stage beside
 * its log, the stages, and the repositories found on this PC. (Settings is the kit's: shell.tsx.)
 */

/** A link to a page on a repository's host (links.ts); its words alone where it has none (a local one, plain git). */
const Link = ({ url, children }: { url: string | null; children: ReactNode }) =>
  url ? (
    <a href={url} rel="noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );

function KitCell({ r, kit }: { r: StaffRowView; kit: string | null }) {
  if (!r.usesKit) return <Badge label="not using the kit yet" />;
  const m = r.main;
  if (!m) return <Text variant="muted">unknown</Text>;
  if (!m.kit) return <Badge tone="caution" label="no kit.json" />;
  return (
    <Badge tone={m.kit === kit ? 'success' : 'caution'} title={m.parts ? `parts: ${m.parts.join(', ')}` : undefined} label={<>kit {m.kit}</>} />
  );
}

/** A repository's latest release, linked, with the kit it carries; "no release yet" before its first. */
function ReleaseCell({ r }: { r: StaffRowView }) {
  const rel = r.release;
  const kit = !rel ? '' : rel.kit === 'unknown' ? '' : rel.kit ? `, kit ${rel.kit}` : ', no kit';
  return rel ? (
    <>
      <Link url={releaseUrl(r.repo, r.host, rel.tag, r.site)}>{rel.tag}</Link>
      <Text variant="muted">{kit}</Text>
    </>
  ) : (
    <Text variant="muted">no release yet</Text>
  );
}

/**
 * One of the Steward's PRs or the team's, in its repository's card: its number and title with how it stands (checks,
 * mergeable, draft) on a line, its branch (and whose, for a team member's) and what it asks for once merged under it.
 */
function Pr({ p, branch }: { p: PrView; branch: string }) {
  const team = p.whose === 'team';
  return (
    <li className="sw-pr">
      <div className="sw-line">
        <Link url={p.url}>#{p.number}</Link>
        <span className="sw-pr-title">{p.title}</span>
        {team && <Badge title={`Opened by ${p.author}: whoever opened it merges it once it is vouched`} label="team" />}
        <Badge tone={p.checks === 'failing' ? 'danger' : p.checks === 'pending' ? 'caution' : 'success'} label={<>checks {p.checks}</>} />
        <Badge tone={p.mergeable === 'MERGEABLE' ? 'success' : p.mergeable === 'CONFLICTING' ? 'danger' : 'caution'} label={p.mergeable.toLowerCase()} />
        {p.draft && <Badge tone="caution" label="draft" />}
        {p.base && p.base !== branch && <Badge tone="caution" title={`Merge only takes a PR into ${branch}`} label={<>into {p.base}</>} />}
        {/* Why what it asks for once merged (its steward block) can't be read. */}
        {p.afterError && <Badge tone="danger" title={p.afterError} label="steward block" />}
      </div>
      <Text variant="muted" className="sw-sub">
        {p.head}
        {team ? `, ${p.author}'s` : ''}
        {p.afterText ? ` · then: ${p.afterText}` : ''}
      </Text>
    </li>
  );
}

/** What each host calls a PR, for the heading over a repository's: GitLab's are merge requests. Plain git has none. */
const PRS_CALLED: Record<Host, string> = { github: 'Pull requests', gitlab: 'Merge requests', azure: 'Pull requests', gitea: 'Pull requests', bitbucket: 'Pull requests', git: 'Branches' };

/** A repository's open PRs under a small heading in its host's words, and a branch prepared here and not pushed. */
function PrList({ r }: { r: StaffRowView }) {
  return (
    <div className="sw-part">
      {r.prs.length > 0 && <div className="sw-head-small">{PRS_CALLED[r.host ?? 'github']}</div>}
      <ul className="sw-list">
        {r.prs.map((p) => (
          <Pr key={p.number} p={p} branch={r.branch} />
        ))}
        {r.prepared && (
          <li>
            <code>{r.prepared.branch}</code> <Text variant="muted">{r.prepared.ahead} ahead, not pushed?</Text>
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * What a repository's next build releases (StaffRow.nextBuild): how many commits since its last release, folded open
 * to them, newest first, a merged PR as its number and title. Linked on its host (links.ts), where a compare shows them
 * all; a PR by its number on GitHub only, whose merge commits name it. Nothing when there are none.
 */
function NextBuild({ r }: { r: StaffRowView }) {
  const n = r.nextBuild;
  if (!n?.count) return null;
  // Over plain git an owner/name's commits aren't linked, as before: its origin may be any server's (a NAS's), so named.
  const linked = !(r.host === 'git' && kindOf(r.repo, null) === 'github');
  const gh = linked && kindOf(r.repo, r.host) === 'github' ? repoUrl(r.repo) : null;
  const compare = linked ? compareUrl(r.repo, r.host, n.commit, r.branch, r.site) : null;
  const commits = `${n.count} ${n.count === 1 ? 'commit' : 'commits'} since ${n.tag}`;
  const more = n.count - n.commits.length;
  return (
    <details className="sw-part sw-next">
      <summary>
        {r.releases === false ? `Not released by the Steward: ${commits}` : `Next build brings ${commits}`}
        {compare && (
          <>
            {' '}
            (<Link url={compare}>compare</Link>)
          </>
        )}
      </summary>
      <ul className="sw-list sw-commits">
        {n.commits.map((c) => (
          <li key={c.sha}>
            {/* A merged PR by its number, a commit pushed without one by its own. */}
            <Link url={c.pr !== null ? (gh ? `${gh}/pull/${c.pr}` : null) : linked ? commitUrl(r.repo, r.host, c.sha, r.site) : null}>{c.pr !== null ? <>#{c.pr}</> : <code>{c.sha}</code>}</Link> {c.title}
          </li>
        ))}
        {more > 0 && (
          <li>
            <Text variant="muted">and {more} more</Text>
          </li>
        )}
      </ul>
    </details>
  );
}

/** What Settings let the Steward do with a repository: release it. Off until the person says yes. Its PRs are merged by whoever wrote them. */
function Allowed({ r }: { r: StaffRowView }) {
  return (
    <>
      <Badge tone={r.releases ? 'success' : 'neutral'} title={r.releases ? 'Releases each new version on its branch' : 'Not released by the Steward: Settings name no way to (Release it)'} label={r.releases ? 'releases' : 'not released'} />
    </>
  );
}

/** The notes a row shows: "not using the kit yet" is said by its kit cell. */
const shownNotes = (r: StaffRowView) => r.notes.filter((n) => n !== 'not using the kit yet');

/**
 * One repository, as a card: its name, its kit (on Castellan's own PC) or whether the Steward releases it, a version
 * not released yet, and its latest release on a line; its branch's version, its parts and your checkout on the next.
 * Then, as it has them: its release PC (lease.ts) with its buttons, its notes, what its next build brings (folded),
 * and its open PRs.
 */
function StaffCard({ r, kit, castellan, turn }: { r: StaffRowView; kit: string | null; castellan: boolean; turn?: TurnRow }) {
  const co = r.checkout;
  const notes = shownNotes(r);
  return (
    <Card className="sw-repo">
      <div className="sw-line">
        <strong className="sw-name">
          <Link url={repoUrl(r.repo, r.site)}>{r.name}</Link>
        </strong>
        {castellan ? <KitCell r={r} kit={kit} /> : <Allowed r={r} />}
        {r.releaseNeeded && r.main?.version && <Badge tone="caution" label={<>{r.main.version} not released</>} />}
        <span className="sw-end">
          <ReleaseCell r={r} />
        </span>
      </div>
      <div className="sw-facts">
        <span>{r.main ? <>{r.branch} {r.main.version ?? '?'} <code>{r.main.commit}</code></> : `${r.branch}: unknown`}</span>
        {castellan && <span>{r.main?.parts?.join(', ') || 'no parts'}</span>}
        <span className="sw-path">
          {co.exists ? (
            <>
              <code>{co.path}</code>
              {co.branch ? ` on ${co.branch}` : ''}
              {co.changes ? `, ${co.changes} changed` : ''}
            </>
          ) : (
            <>
              no checkout at <code>{co.path}</code>
            </>
          )}
        </span>
      </div>
      {turn && <TurnCell x={turn} />}
      {notes.length > 0 && <Notes items={notes} />}
      <NextBuild r={r} />
      {(r.prs.length > 0 || r.prepared) && <PrList r={r} />}
    </Card>
  );
}

/**
 * The staff, a card each, side by side as the window allows. Turns for no card here, claims another PC made too
 * (claims.ts) and the PRs passed over in their version lines (passover.ts), under them.
 */
function StaffCards({ s, castellan, turns, clashes, passed }: { s: StaffView | null; castellan: boolean; turns: TurnsView | null | undefined; clashes?: string[]; passed?: string[] }) {
  const rows = s?.rows ?? [];
  const turnOf = new Map((turns?.rows ?? []).map((x) => [x.id, x]));
  const loose = (turns?.rows ?? []).filter((x) => !rows.some((r) => r.id === x.id));
  const under = (loose.length > 0 || (clashes?.length ?? 0) > 0 || (passed?.length ?? 0) > 0) && (
    <div className="turns">
      {loose.map((x) => (
        <TurnLine key={x.id} x={x} />
      ))}
      {(clashes ?? []).map((c) => (
        <Text variant="muted" as="p" key={c}>
          {c}.
        </Text>
      ))}
      {(passed ?? []).map((c) => (
        <Text variant="muted" as="p" key={c}>
          {c}.
        </Text>
      ))}
    </div>
  );
  if (!s)
    return (
      <Card className="empty">
        Looking at each repository…
        {under}
      </Card>
    );
  if (!rows.length)
    return (
      <Card className="empty" tour="staff">
        No repositories yet. Pick the ones to look after from those Reeve found, under Found on this PC, or add one in
        Settings, under Repositories: its repository (owner/name on GitHub, host/path on another host, or leave it out for
        one on this PC alone), your clone of it, and how to test and release it; its .steward.json says the rest
        (docs/PIPELINE.md).
        {under}
      </Card>
    );
  return (
    <>
      <div className="sw-cards" data-tour="staff">
        {rows.map((r) => (
          <StaffCard key={r.id} r={r} kit={s.kit} castellan={castellan} turn={turnOf.get(r.id)} />
        ))}
      </div>
      {under && <Card>{under}</Card>}
    </>
  );
}

const OUTCOME: Record<EmployeeResult['outcome'], BadgeTone> = { done: 'success', skipped: 'neutral', refused: 'caution', failed: 'danger' };

/**
 * A stage's result for each employee: how it went, in what words, and a link when there is one. What it did (merged,
 * released, failed) first; the employees it skipped, which had nothing to do, folded under their count.
 */
function StageResults({ results }: { results: StageResult['results'] }) {
  const acted = results.filter((r) => r.outcome !== 'skipped');
  const skipped = results.filter((r) => r.outcome === 'skipped');
  return (
    <>
      {acted.length > 0 ? <ResultList results={acted} /> : <Text variant="muted" as="p">Nothing to do for anyone.</Text>}
      {skipped.length > 0 && (
        <details>
          <summary>
            {skipped.length} skipped, with nothing to do
          </summary>
          <ResultList results={skipped} />
        </details>
      )}
    </>
  );
}

/** Each employee's result: its name and how it went on a line, what was done (and a link to it) under it. */
function ResultList({ results }: { results: StageResult['results'] }) {
  return (
    <ul className="sw-list sw-results">
      {results.map((r, i) => (
        <li key={i}>
          <div className="sw-line">
            <strong>{r.name}</strong>
            <Badge tone={OUTCOME[r.outcome]} label={r.outcome} />
          </div>
          <Text variant="muted" className="sw-sub">
            {r.message}
            {r.url && (
              <>
                {' '}
                <Link url={r.url}>link</Link>
              </>
            )}
          </Text>
        </li>
      ))}
    </ul>
  );
}

/** The last stage: what it was and when, why it stopped if it did, and each employee's result. Its log is beside it (StageLog). */
function LastStage({ l, now }: { l: StageResult | null; now: number }) {
  if (!l)
    return (
      <Card className="empty" tour="last">
        No stage has run yet.
      </Card>
    );
  const asked = askedWords(l.asked);
  return (
    <Card tour="last">
      <p>
        <strong>{l.stage}</strong>
        {l.kit ? ` to kit ${l.kit}` : ''}, {ago(l.finished, now)}
        {asked && (
          <>
            {' '}
            <Text variant="muted">({asked})</Text>
          </>
        )}
      </p>
      {l.error && (
        <p>
          <Badge tone="danger" label="stopped" /> {l.error}
        </p>
      )}
      {l.results.length > 0 && <StageResults results={l.results} />}
    </Card>
  );
}

/** The last stage's log, whole, in a box of its own that scrolls. */
function StageLog({ l }: { l: StageResult | null }) {
  if (!l) return null;
  return (
    <Section title={`Its log (${l.log.length} ${l.log.length === 1 ? 'line' : 'lines'})`}>
      <div className="sw-log">
        <Output text={l.log.join('\n')} label={`The ${l.stage} log`} />
      </div>
    </Section>
  );
}

/** A build time: "18:00" today, else "Mon 18:00". */
export function buildAt(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
}

/**
 * What a round does, and when it comes, in words: the round line, and the question Run now asks. With no repositories
 * here (steward.ts's reposHere) a round only keeps the staff's pages up (tend.ts), or, with that off, has nothing to do.
 */
export function roundWords(r: RoundView, now = Date.now()): { what: string; when: string } {
  const more = [r.releaseSelf ? 'releases its own new versions' : '', r.rollout ? 'rolls a new kit out to each employee behind it' : ''].filter(Boolean);
  const repoWork =
    r.castellan === false
      ? 'releases each new version on a branch in the repositories you said yes to, where Settings say how (you merge your own PRs)'
      : `releases each employee whose branch carries something new (everyone merges their own PRs), ${more.length ? `${more.join(', ')}, ` : ''}and approves the jobs whose installed scripts are the released ones`;
  const tend = "reopens, through Manor, any on-duty agent's page that stops answering, and retries once an update rolled back only by a moment offline";
  const noRepos = r.repos === false;
  const what = noRepos
    ? r.tend
      ? `${tend}, and raises the alarms (there are no repositories to look after on this PC)`
      : 'raises the alarms: there are no repositories to look after on this PC'
    : r.tend
      ? `${repoWork}, and ${tend}`
      : repoWork;
  const after = `${r.onDuty ? '' : ' Off duty, the rounds wait.'}${r.lastRunAt ? ` The last ended ${ago(r.lastRunAt, now)}.` : ''}`;
  const when = noRepos
    ? r.tend
      ? `No repositories to look after on this PC, so a round every ${r.minutes} minutes while on duty ${tend}, and raises the alarms. Pick a repository of yours to look after, or add one in Settings.${after}`
      : "Nothing to do: there are no repositories to look after on this PC, and \"Keeps the staff's pages up\" is off in Settings (or Manor's page isn't named under Alarms). Pick a repository of yours to look after, or switch it on."
    : !r.on
      ? r.tend
        ? `It releases only when asked, until you say yes: "Builds and releases by itself" is off in Settings. A round every ${r.minutes} minutes while on duty only ${tend}.${after} Run now does a whole round.`
        : 'It releases only when asked, until you say yes: "Builds and releases by itself" is off in Settings. Run now does one round.'
      : r.build
        ? `It builds at set times (${r.build.times.join(', ')}; Settings: Build pipeline): a build ${what}, each repository released once. ${r.build.building ? 'A build is under way now.' : r.build.next ? `The next build is at ${buildAt(r.build.next, now)}.` : 'No build time is set to come.'}${r.build.late ? ` ${r.build.late.charAt(0).toUpperCase()}${r.build.late.slice(1)}.` : ''}${r.build.wakes ? ' Plugged in, the PC is woken a few minutes before each build, and kept up until it closes.' : ''} Between builds, a round every ${r.minutes} minutes releases nothing, except for an urgent fix (a commit on main whose changelog entry starts "**Urgent fix:"): that builds at once, for its repository alone. An urgent kit goes out to every agent in that build, and each is built at once after it. Where Settings say so, a round also vouches for one of the team's open PRs no one has vouched for yet, as steward vouch would, and never merges it.${after}`
        : `By itself, a round every ${r.minutes} minutes while on duty: it ${what}.${after}`;
  // Where the last build's time went (buildtimes.ts), and that what is merged between builds is released at the next.
  const took = r.on && !noRepos && r.build?.took ? ` ${r.build.took} Between builds, whoever wrote a PR merges it once vouched, and the next build releases it.` : '';
  // A vendor's screen saver putting the PC to sleep stops the rounds whatever they do: said whatever the mode.
  const asleep = r.asleep ? ` ${r.asleep}` : '';
  return { what, when: `${when}${took}${asleep}` };
}

/**
 * The staff's pages as the last round's look left them (tend.ts): the agents on duty whose pages don't answer, and the
 * ones lately opened again. Shown while there is something to say, and always with no repositories (it is the work then).
 */
function TendingCard({ t, r, now }: { t: TendState | undefined; r: RoundView; now: number }) {
  if (!t) return null;
  const down = Object.entries(t.down);
  if (!down.length && !t.revived.length && r.repos !== false) return null;
  const times = (n: number) => `${n} time${n === 1 ? '' : 's'}`;
  return (
    <Section title="The staff's pages" count={down.length || undefined}>
      <Card>
        {!t.at ? (
          <Text variant="muted" as="p">
            Not looked at yet: the next round looks.
          </Text>
        ) : !t.manor ? (
          <Text variant="muted" as="p">
            Manor's page didn't answer the last look ({ago(t.at, now)}), so the staff's pages couldn't be seen.
          </Text>
        ) : (
          !down.length && (
            <Text variant="muted" as="p">
              Every agent on duty answered, {ago(t.at, now)}.
            </Text>
          )
        )}
        {down.length > 0 && (
          <Notes
            items={down.map(([id, d]) => (
              <span key={id}>
                <strong>{d.name}</strong> is on duty, but its page hasn't answered since {ago(d.since, now)}
                {d.tries ? `: opened again ${times(d.tries)}` : ''}
                {d.said ? <Text variant="muted"> ({d.said})</Text> : null}
              </span>
            ))}
          />
        )}
        {t.revived.length > 0 && (
          <details>
            <summary className="muted">Opened again lately</summary>
            <Notes
              items={t.revived.slice(0, 10).map((x) => (
                <>
                  {x.name} <Text variant="muted">({ago(x.at, now)})</Text>
                </>
              ))}
            />
          </details>
        )}
      </Card>
    </Section>
  );
}

/** The stages running now, side by side; a page from a Steward before that gives only `running`. */
const runsOf = (v: StewardView) => v.runs ?? (v.running ? [v.running] : []);
/** No stage can start now: every slot taken (Settings' Stages at once); before slots, any one running. */
const noSlot = (v: StewardView) => v.full ?? !!v.running;

/**
 * Run now, in the title bar: a round now, on duty or not, asked first. Only while "Builds and releases by itself" is
 * off: by itself its rounds come anyway, and a button that only jumps their queue says the person has to start them.
 */
export function RunNow({ v }: { v: StewardView }) {
  if (v.off || v.round.on) return null;
  return (
    <PostButton title="Run now" variant="secondary" path="/api/run" confirm={`A round now: it ${roundWords(v.round).what}?`} disabled={noSlot(v) || runsOf(v).some((r) => r.stage === 'round')} />
  );
}

/** The alarms open and not dismissed (alarms.ts): what needs the person now. */
const openAlarms = (a: AlarmState | undefined) => (a?.open ?? []).filter((x) => !x.dismissedAt);

/** An alarm's facts and since when, under its title. */
const AlarmFacts = ({ x, now }: { x: Alarm; now: number }) => (
  <>
    {x.detail.length > 0 && <Notes items={x.detail} />}
    <Text variant="muted">
      Since {ago(x.since, now)}
      {x.dismissedAt ? `, dismissed ${ago(x.dismissedAt, now)}` : ''}
    </Text>
  </>
);

/** The alarms dismissed and lately cleared, folded away: under Needs you while it shows, else in the Last stage tab. */
function AlarmHistory({ a, now }: { a: AlarmState | undefined; now: number }) {
  const dismissed = (a?.open ?? []).filter((x) => x.dismissedAt);
  const cleared = a?.cleared ?? [];
  if (!dismissed.length && !cleared.length) return null;
  return (
    <div className="sw-history">
      {dismissed.length > 0 && (
        <details>
          <summary className="muted">{dismissed.length} dismissed: back if they clear and return</summary>
          {dismissed.map((x) => (
            <div className="alarm" key={x.id}>
              <strong>{x.url ? <Link url={x.url}>{x.title}</Link> : x.title}</strong>
              <AlarmFacts x={x} now={now} />
            </div>
          ))}
        </details>
      )}
      {cleared.length > 0 && (
        <details>
          <summary className="muted">Lately cleared</summary>
          <Notes
            items={cleared.slice(0, 10).map((x) => (
              <>
                {x.title} <Text variant="muted">(cleared {ago(x.clearedAt, now)})</Text>
              </>
            ))}
          />
        </details>
      )}
    </div>
  );
}

/**
 * What needs the person (alarms.ts), at the top, in the kit's Needs you: each open alarm with its facts, its action and
 * Dismiss; the dismissed and the lately cleared folded under them. Nothing while none is open.
 */
export function AlarmsCard({ a, now }: { a: AlarmState | undefined; now: number }) {
  const showing = openAlarms(a);
  if (!showing.length) return null;
  const items: Need[] = showing.map((x) => ({
    id: x.id,
    tone: 'danger',
    label: 'alarm',
    title: x.url ? <Link url={x.url}>{x.title}</Link> : x.title,
    action: (
      <span className="row sw-buttons">
        {x.action && <PostButton title={x.action.label} path="/api/alarms/act" body={{ id: x.id }} confirm={x.action.confirm} />}
        <PostButton title="Dismiss" variant="secondary" path="/api/alarms/dismiss" body={{ id: x.id }} />
      </span>
    ),
    children: <AlarmFacts x={x} now={now} />,
  }));
  return (
    <NeedsYou items={items}>
      <AlarmHistory a={a} now={now} />
    </NeedsYou>
  );
}

/** A turn's buttons (lease.ts): on another PC, Do it here and Keep it on this PC; on this one, Keep it on this PC or Unpin. */
function TurnButtons({ x }: { x: TurnRow }) {
  if (x.status === 'elsewhere')
    return (
      <span className="row turn-buttons">
        <PostButton
          title="Do it here"
          variant="secondary" size="sm"
          path="/api/turns/take"
          body={{ repo: x.repo }}
          confirm={`Release ${x.name} from this PC from now on? ${x.holder} leaves it alone from its next look.`}
        />
        <PostButton
          title="Keep it on this PC"
          variant="secondary" size="sm"
          path="/api/turns/take"
          body={{ repo: x.repo, pin: true }}
          confirm={`Release ${x.name} from this PC, and keep it here? Other PCs leave it alone while this PC is around.`}
        />
      </span>
    );
  if (x.status === 'here')
    return x.pinned ? (
      <PostButton title="Unpin" variant="secondary" size="sm" path="/api/turns/take" body={{ repo: x.repo, pin: false }} />
    ) : (
      <PostButton title="Keep it on this PC" variant="secondary" size="sm" path="/api/turns/take" body={{ repo: x.repo, pin: true }} confirm={`Keep ${x.name} on this PC? Other PCs leave it alone while this PC is around.`} />
    );
  return null;
}

const sentence = (s: string | null) => (s ? `${s[0].toUpperCase()}${s.slice(1)}.` : '');

/** A repository's release PC, in its card: who releases it, kept there or not, and the buttons. */
function TurnCell({ x }: { x: TurnRow }) {
  if (x.status === 'unreachable' || x.status === 'alone')
    return (
      <Text variant="muted" as="div" className="turn-cell">
        {sentence(x.note)}
      </Text>
    );
  return (
    <div className="turn-cell">
      <div className="sw-line">
        <span>
          Released from {x.status === 'here' ? 'this PC' : <strong>{x.holder}</strong>}
          {x.pinned ? <Text variant="muted"> (kept there)</Text> : null}
        </span>
        <TurnButtons x={x} />
      </div>
      {x.quiet ? <Text variant="muted" className="sw-sub">{`${x.holder} has gone quiet: after a day without it, another PC may take it`}</Text> : null}
    </div>
  );
}

/** A turn with no row in the staff's table (it is still being looked at), on its own line under it. */
function TurnLine({ x }: { x: TurnRow }) {
  return (
    <div className="row turn">
      <span>
        {x.status === 'unreachable' || x.status === 'alone' ? (
          <>
            {x.name}: <Text variant="muted">{sentence(x.note)}</Text>
          </>
        ) : (
          <>
            Releasing for {x.name}: {x.status === 'here' ? 'this PC' : <>done by <strong>{x.holder}</strong></>}
            {x.pinned ? ' (kept there)' : ''}
            {x.quiet ? <Text variant="muted">{`. ${x.holder} has gone quiet: after a day without it, another PC may take it`}</Text> : null}
          </>
        )}
      </span>
      <TurnButtons x={x} />
    </div>
  );
}

/** One box for every pick: ticks them all, or none once all are; half-ticked while only some are, with how many. */
function PickAll({ count, of, onChange }: { count: number; of: number; onChange: (on: boolean) => void }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = count > 0 && count < of;
  }, [count, of]);
  return (
    <label className="pick pick-all">
      <input ref={box} type="checkbox" checked={count === of && of > 0} onChange={(e) => onChange(e.target.checked)} aria-label="Tick every repository" /> {`All (${count} of ${of})`}
    </label>
  );
}

/**
 * The stages, for the ticked employees: one that doesn't take the kit starts unticked. The Steward's own row isn't one:
 * its builds release it (stages/self.ts).
 */
function Stages({ v }: { v: StewardView }) {
  const s = v.staff;
  const kit = s?.kit ?? null;
  const rows = (s?.rows ?? []).filter((r) => !r.self);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const castellan = v.castellan !== false;
  const isTicked = (r: StaffRowView) => ticked[r.id] ?? (castellan ? r.usesKit : true);
  const all = <PickAll count={rows.filter(isTicked).length} of={rows.length} onChange={(on) => setTicked(Object.fromEntries(rows.map((r) => [r.id, on])))} />;
  const ask = () => ({ kit: kit ?? '', employees: rows.filter(isTicked).map((r) => r.id) });
  const onKit = rows.filter((r) => r.usesKit);
  const offKit = rows.filter((r) => !r.usesKit);
  const who = `the ticked employees (${onKit.length} take the kit)`;
  const noKit = noSlot(v) || !kit;
  const one = offKit.length === 1;
  const offKitNote = offKit.length ? ` ${offKit.map((r) => r.name).join(' and ')} ${one ? "doesn't" : "don't"} take the kit yet: the stages pass over ${one ? 'it' : 'them'}.` : '';
  const stage = (label: string, path: string, confirm: string, disabled: boolean, tooltip?: string) => (
    <PostButton title={label} path={`/api/stage/${path}`} body={ask} confirm={confirm} disabled={disabled} tooltip={tooltip} />
  );
  if (!castellan) {
    return (
      <Card tour="stages">
        <div className="picks">
          {all}
          {rows.map((r) => (
            <label key={r.id} className="pick">
              <input type="checkbox" name="employees" value={r.id} checked={isTicked(r)} onChange={(e) => setTicked({ ...ticked, [r.id]: e.target.checked })} /> {r.name}
            </label>
          ))}
        </div>
        <div className="row stages">
          {stage('Release', 'release', 'Release each ticked repository whose branch carries a version with no release yet, the way Settings say for it?', noSlot(v))}
          <PostButton title={v.refreshing ? 'Refreshing…' : 'Refresh'} variant="secondary" icon="refresh" path="/api/staff/refresh" disabled={!!v.running || v.refreshing} />
        </div>
        <Text variant="muted" as="p">
          Release asks first, then reports on each ticked repository in Last stage. Nothing is released until Settings say how. The Steward merges no PRs: merge your own once vouched.
        </Text>
      </Card>
    );
  }
  return (
    <Card tour="stages">
      <div className="picks">
        {all}
        {rows.map((r) => (
          <label key={r.id} className="pick" title={r.usesKit ? undefined : "Doesn't take the kit yet"}>
            <input type="checkbox" name="employees" value={r.id} checked={isTicked(r)} onChange={(e) => setTicked({ ...ticked, [r.id]: e.target.checked })} /> {r.name}
          </label>
        ))}
      </div>
      <div className="row stages">
        {stage('1. Bump', 'bump', `Bump ${who} to kit ${kit}? For each: a worktree of its branch, kit.json pinned to ${kit}, its patch version up, its kit filled and its checks run, then a commit. Nothing is pushed.`, noKit)}
        {stage('2. Push', 'push', `Push the bumps to kit ${kit} and open their PRs? Nothing is force-pushed.`, noKit)}
        {stage('3. Release', 'release', `Release each ticked employee whose branch has kit ${kit} and an unreleased version, from that branch?`, noKit)}
        <PostButton title={v.refreshing ? 'Refreshing…' : 'Refresh'} variant="secondary" icon="refresh" path="/api/staff/refresh" disabled={!!v.running || v.refreshing} />
      </div>
      <Text variant="muted" as="p">
        Each stage asks first, then reports on each ticked employee in Last stage. The Steward merges only its own kit PRs, in the build that rolls them out.{offKitNote}
      </Text>
    </Card>
  );
}

/** Words in sentences, each its own: the rounds' words as bullets. A sentence ends at a full stop before a capital or a quote. */
export const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=\.)\s+(?=["A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);

/** What the rounds do and when, beside the stages (or under the last stage, with none): roundWords' sentences as bullets. */
function RoundCard({ r, now }: { r: RoundView; now: number }) {
  return (
    <Section title="Its rounds" tour="rounds">
      <Card className="sw-round">
        <ul>
          {sentencesOf(roundWords(r, now).when).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}

/**
 * The repositories Reeve found on this PC that you can push to and the Steward doesn't look after yet (found.ts), each
 * with Look after: added to Settings with releasing as ticked here, off unless you tick it. Several
 * picked (their boxes, or All) are looked after in one go, each with its own ticks.
 */
function FoundCard({ f, finding, now, tour }: { f: FoundView | undefined; finding: boolean; now: number; tour?: string }) {
  const [asked, setAsked] = useState<Record<string, { merges: boolean; release: boolean }>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  // Add: any clone by its folder, on any host or none (found.ts's foundOfFolder), one Reeve didn't list.
  const [folder, setFolder] = useState('');
  const [folderRelease, setFolderRelease] = useState(false);
  if (!f) return null;
  const of = (repo: string) => asked[repo] ?? { merges: false, release: false };
  const set = (repo: string, k: 'merges' | 'release', on: boolean) => setAsked({ ...asked, [repo]: { ...of(repo), [k]: on } });
  // Only those still offered: one looked after leaves the list, and its pick with it.
  const picks = f.offered.filter((r) => picked[r.repo]);
  const all = f.offered.length > 0 && picks.length === f.offered.length;
  const pickAll = (on: boolean) => setPicked(Object.fromEntries(f.offered.map((r) => [r.repo, on])));
  return (
    <Section title="Found on this PC" count={f.offered.length || undefined}>
      <Card tour={tour}>
        {f.error && !f.offered.length ? (
          <Text variant="muted" as="p">
            {f.error}. Add a repository in Settings, under Repositories, instead.
          </Text>
        ) : !f.at ? (
          <Text variant="muted" as="p">
            {finding ? 'Asking Reeve which repositories are on this PC…' : 'Not looked yet.'}
          </Text>
        ) : !f.offered.length ? (
          <Text variant="muted" as="p">
            {f.found ? 'Every repository Reeve found that you can push to is looked after already.' : 'Reeve found no repository here.'}
          </Text>
        ) : (
          <>
            <Text variant="muted" as="p">
              Your repositories that Reeve found here: on GitHub the ones you can push to, and each one on another host or on
              this PC alone. Look after one to have its versions claimed, and its PRs and releases watched, or tick several and look after them in one go. It releases its new versions only if you tick that; you merge your own PRs.{f.into === 'manor' ? " It goes into Manor's Repositories, the one list every agent reads: change or remove it there." : ''}
            </Text>
            <div className="row pick-bar">
              <label className="pick">
                <input type="checkbox" checked={all} onChange={(e) => pickAll(e.target.checked)} aria-label="Pick every repository" /> All
              </label>
              <PostButton
                title={picks.length ? `Look after ${picks.length}` : 'Look after the picked'}
                path="/api/repos/look-after"
                disabled={!picks.length}
                body={() => ({ repos: picks.map((r) => ({ repo: r.repo, ...of(r.repo) })) })}
              />
            </div>
            <ul className="sw-list sw-found">
              {f.offered.map((r) => (
                <li key={r.repo} className="sw-line">
                  <input type="checkbox" checked={!!picked[r.repo]} onChange={(e) => setPicked({ ...picked, [r.repo]: e.target.checked })} aria-label={`Pick ${r.repo}`} />
                  <span className="sw-found-name">
                    <strong>
                      <Link url={repoUrl(r.repo)}>{r.repo}</Link>
                    </strong>
                    <Text variant="muted" className="sw-sub">
                      <code>{r.path}</code> {r.branch}
                    </Text>
                  </span>
                  <label className="pick">
                    <input type="checkbox" checked={of(r.repo).release} onChange={(e) => set(r.repo, 'release', e.target.checked)} /> Release each new version
                  </label>
                  <PostButton title="Look after" path="/api/repos/look-after" body={() => ({ repo: r.repo, ...of(r.repo) })} />
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="row pick-bar add-clone">
          <Input label="Add a clone by its folder" value={folder} onChangeText={setFolder} placeholder="C:\\Projects\\my-app" />
          <label className="pick">
            <input type="checkbox" checked={folderRelease} onChange={(e) => setFolderRelease(e.target.checked)} /> Release each new version
          </label>
          <PostButton title="Add" variant="secondary" path="/api/repos/look-after" disabled={!folder.trim()} body={() => ({ folder, release: folderRelease })} />
        </div>
        <Text variant="muted" as="p">
          On GitHub, another host or none: its <code>.steward.json</code> says how it is built and released (docs/PIPELINE.md),
          and <code>steward build --dry-run</code> shows it first.
        </Text>
        <div className="row round">
          <Text variant="muted">{f.at ? `Looked ${ago(f.at, now)}${f.from === 'file' ? ", from Reeve's last scan" : ''}.` : ''}</Text>
          <PostButton title={finding ? 'Looking…' : 'Look again'} variant="secondary" icon="refresh" path="/api/repos/refresh" disabled={finding} />
        </div>
      </Card>
    </Section>
  );
}

/**
 * The Steward's own styles, beside the kit's. The page stops widening at 1680 px; a tab of two parts has them side by
 * side (5:7) from 1100 px, one under the other below; the staff's cards side by side as the width allows.
 */
const STYLE = `
.titlebar, main.view, .ui-page-area > footer { max-width: 1680px; margin-inline: auto; }
.sw-pair { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 0 20px; align-items: start; }
@media (max-width: 1099.98px) { .sw-pair { grid-template-columns: minmax(0, 1fr); } }
.sw-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); gap: 12px; align-items: start; margin-bottom: 12px; }
.sw-cards > .card { margin: 0; }
.sw-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.sw-end { margin-left: auto; font-size: 13px; }
.sw-name { font-size: 16px; }
.sw-facts { display: flex; flex-wrap: wrap; gap: 2px 14px; color: var(--muted); font-size: 13px; margin-top: 4px; }
.sw-path { overflow-wrap: anywhere; }
.sw-part { margin-top: 10px; }
.sw-head-small { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 2px; }
ul.sw-list { list-style: none; margin: 0; padding: 0; }
ul.sw-list > li { padding: 6px 0; border-top: 1px solid var(--line); }
ul.sw-list > li:first-child { border-top: 0; }
.sw-pr-title { min-width: 0; overflow-wrap: anywhere; }
.sw-sub { display: block; font-size: 13px; margin-top: 2px; overflow-wrap: anywhere; }
.sw-next > summary { cursor: pointer; font-size: 13px; }
.sw-commits { font-size: 13px; }
.sw-found-name { flex: 1 1 260px; min-width: 0; }
.sw-log .ui-output { max-height: 70vh; overflow: auto; }
.sw-round ul { margin: 0; padding-left: 18px; }
.sw-round li + li { margin-top: 6px; }
.sw-buttons { gap: 6px; flex-wrap: wrap; }
.sw-history { margin-top: 8px; }
.notes { margin: 0; padding-left: 16px; color: var(--muted); font-size: 13px; }
.picks { display: flex; gap: 6px 16px; flex-wrap: wrap; margin-bottom: 10px; }
.pick { display: inline-flex; gap: 6px; align-items: center; }
.add-clone { align-items: flex-end; margin-top: 12px; }
.add-clone .ui-input { flex: 1 1 260px; min-width: 0; }
.pick-all { font-weight: 600; padding-right: 12px; border-right: 1px solid var(--line); }
.pick-bar { gap: 12px; align-items: center; margin: 8px 0; }
.stages { margin-bottom: 6px; }
.round { gap: 10px; align-items: center; justify-content: space-between; margin-top: 8px; }
.turn-cell button { white-space: nowrap; }
.alarm + .alarm, .alarm + details, details + details { margin-top: 10px; }
.turn { justify-content: space-between; align-items: center; gap: 10px; padding: 4px 0; }
.turn-cell { margin-top: 6px; font-size: 13px; }
.turn-buttons { gap: 6px; flex-wrap: wrap; }
.alarm .notes { margin: 4px 0; }
`;

/** A tab's two parts: side by side from 1100 px (5:7), one under the other below. */
const Pair = ({ left, right }: { left: ReactNode; right: ReactNode }) => (
  <div className="sw-pair">
    <div>{left}</div>
    <div>{right}</div>
  </div>
);

/**
 * The kit the Steward hands out, and how old the staff's table is. With no one to hand it to (`handsOut` false: no
 * employees, no repositories here), the kit it manages: kept current so the Steward itself runs, and handed to no one.
 */
function KitCard({ s, now, handsOut }: { s: StaffView | null; now: number; handsOut: boolean }) {
  if (s && !handsOut)
    return (
      <Card>
        <p>
          The kit the Steward manages: <strong>{s.kit ?? s.local ?? 'none'}</strong>
        </p>
        <Text variant="muted" as="p">
          With no repositories to look after here, it hands the kit to no one: it keeps it only to run on itself.
        </Text>
      </Card>
    );
  return (
    <Card>
      {s ? (
        <>
          <p>
            The kit the Steward hands out: <strong>{s.kit ?? 'none'}</strong>
            {s.released.length > 0 && (
              <>
                {' '}
                <Text variant="muted">(released: {s.released.slice(0, 5).join(', ')})</Text>
              </>
            )}
            {s.local && (
              <>
                {' '}
                <Text variant="muted">· this checkout's kit\VERSION: {s.local}</Text>
              </>
            )}
          </p>
          {s.kitNote && <Text variant="muted" as="p">{s.kitNote}</Text>}
          <Text variant="muted" as="p">
            The table is from {ago(s.at, now)}
            {s.checked && s.checked !== s.at ? `; their hosts had nothing new for it ${ago(s.checked, now)}` : ''}.
          </Text>
        </>
      ) : (
        <Text variant="muted" as="p">Looking at the staff for the first time…</Text>
      )}
    </Card>
  );
}

/** The whole suite before a kit's release, while it runs beside the rounds (stages/wholesuite.ts): the kit waits for it, the merges don't. */
export function WholeSuiteCard({ w, now }: { w: WholeJob | null | undefined; now: number }) {
  if (!w || w.state !== 'running') return null;
  return (
    <Card className="row">
      <Badge tone="info" label="Whole suite" />{' '}
      <span>
        Before {w.tag}'s release, the Steward's whole suite runs at {w.commit.slice(0, 7)}, beside the rounds, since {ago(w.startedAt, now)}. The rounds go on meanwhile; the first after it passes releases the kit.
      </span>
    </Card>
  );
}

/**
 * The page at a glance: what needs you, the staff (or your repositories) and how many are behind, the next build and
 * what it brings, the open PRs and how many fail, and the last stage. Each opens the tab it is about.
 */
export function tilesOf(v: StewardView, now: number): GlanceTile[] {
  const castellan = v.castellan !== false;
  const rows = v.staff?.rows ?? [];
  const tiles: GlanceTile[] = [];
  if (v.alarms) {
    const open = openAlarms(v.alarms).length;
    tiles.push(open ? { label: 'Needs you', value: open, note: open === 1 ? 'an alarm is open' : 'alarms are open', tone: 'danger', to: 'needs-you' } : { label: 'Needs you', value: 'Nothing', note: 'no alarm is open', tone: 'success' });
  }
  if (v.staff) {
    const kit = castellan ? v.staff.kit : null;
    const behind = kit ? rows.filter((r) => r.usesKit && r.main?.kit && r.main.kit !== kit).length : 0;
    const onKit = kit ? rows.filter((r) => r.main?.kit === kit).length : 0;
    const unreleased = rows.filter((r) => r.releaseNeeded).length;
    const note = [behind ? `${behind} behind kit ${kit}` : '', unreleased ? `${unreleased} not released` : ''].filter(Boolean).join(', ');
    const well = !rows.length ? 'none yet' : kit ? (onKit === rows.length ? `all on kit ${kit}` : `${onKit} on kit ${kit}`) : 'every version released';
    tiles.push({ label: castellan ? 'Staff' : 'Your repositories', value: rows.length, note: note || well, tone: behind || unreleased ? 'caution' : 'neutral', to: 'staff' });
  }
  const r = v.round;
  if (r.repos !== false) {
    const waiting = rows.filter((x) => x.releases !== false && (x.nextBuild?.count ?? 0) > 0);
    const commits = waiting.reduce((n, x) => n + (x.nextBuild?.count ?? 0), 0);
    const brings = waiting.length ? `${commits} ${commits === 1 ? 'commit' : 'commits'} in ${waiting.length} ${waiting.length === 1 ? 'repository' : 'repositories'}` : 'nothing new yet';
    const to = hasEmployees(v) ? 'rounds' : undefined;
    if (!r.on) tiles.push({ label: 'Next build', value: 'When asked', note: `"Builds and releases by itself" is off; ${brings}`, to });
    else if (r.build?.building) tiles.push({ label: 'Next build', value: 'Building now', note: brings, tone: 'caution', to });
    else if (r.build?.next) tiles.push({ label: 'Next build', value: buildAt(r.build.next, now), note: brings, to });
    else tiles.push({ label: 'Next build', value: r.build ? 'None set' : `Every ${r.minutes} min`, note: brings, to });
  }
  if (rows.length) {
    const prs = rows.flatMap((x) => x.prs);
    const failing = prs.filter((p) => p.checks === 'failing' || p.mergeable === 'CONFLICTING').length;
    tiles.push({ label: 'Pull requests', value: prs.length, note: !prs.length ? 'none open' : failing ? `${failing} failing or in conflict` : 'none failing', tone: failing ? 'caution' : 'neutral', to: 'staff' });
  }
  const l = v.last;
  tiles.push(l ? { label: 'Last stage', value: l.stage, note: l.error ? `stopped ${ago(l.finished, now)}` : ago(l.finished, now), tone: l.error ? 'danger' : 'neutral', to: 'last' } : { label: 'Last stage', value: 'None yet', note: 'no stage has run', to: 'last' });
  return tiles;
}

/** The page's body: everything above Settings. */
export function StewardBody({ v }: { v: StewardView }) {
  const now = useNow();
  // Developer options off (maker.ts): the plain line, and nothing else.
  if (v.off)
    return (
      <Card>
        <Text as="p">{v.off}</Text>
      </Card>
    );
  const s = v.staff;
  const castellan = v.castellan !== false;
  const alarmsOpen = openAlarms(v.alarms).length > 0;
  const tabs: PageTab[] = [
    {
      id: 'staff',
      label: castellan ? 'Staff' : 'Your repositories',
      count: s?.rows.length,
      content: <StaffCards s={s} castellan={castellan} turns={v.turns} clashes={v.claimClashes} passed={v.passedOver} />,
    },
    {
      id: 'last',
      label: 'Last stage',
      mark: v.last?.error ? 'It stopped' : undefined,
      content: (
        <Pair
          left={
            <>
              <LastStage l={v.last} now={now} />
              <TendingCard t={v.tending} r={v.round} now={now} />
              {/* With no stages to start, the rounds' words are here. */}
              {!hasEmployees(v) && v.round.repos !== false && <RoundCard r={v.round} now={now} />}
              {/* While an alarm is open they're under Needs you. */}
              {!alarmsOpen && <AlarmHistory a={v.alarms} now={now} />}
            </>
          }
          right={<StageLog l={v.last} />}
        />
      ),
    },
  ];
  if (hasEmployees(v))
    tabs.push({
      id: 'stages',
      label: castellan ? 'Roll out the kit' : 'Release',
      content: <Pair left={<Stages v={v} />} right={<RoundCard r={v.round} now={now} />} />,
    });
  if (foundOnPage(v.found)) tabs.push({ id: 'found', label: 'Found on this PC', count: v.found!.offered.length || undefined, content: <FoundCard f={v.found} finding={!!v.finding} now={now} tour="found" /> });
  return (
    <>
      <style>{STYLE}</style>
      {runsOf(v).map((r) => (
        <Card key={`${r.stage} ${r.since}`} className="row">
          <Badge tone="caution" label="Working" />{' '}
          <span>
            {r.stage}, started {ago(r.since, now)}. This page keeps itself current until it's done.
          </span>
        </Card>
      ))}
      <WholeSuiteCard w={v.wholeSuite} now={now} />
      <AlarmsCard a={v.alarms} now={now} />
      {v.round.repos === false && (
        <Card>
          <Text variant="muted" as="p">
            {roundWords(v.round, now).when}
          </Text>
        </Card>
      )}
      <Glance tiles={tilesOf(v, now)} label="The Steward at a glance" />
      <PageTabs tabs={tabs} label="The Steward's page" />
    </>
  );
}

const hasEmployees = (v: StewardView) => v.staff?.rows.some((r) => !r.self) ?? false;

/** Found on this PC is on the page while there's something to do with it: repositories to look after, a first look, or one that failed. */
const foundOnPage = (f: FoundView | undefined) => !!f && (!f.at || f.offered.length > 0 || !!f.error);

/**
 * The About view, beside Settings in the title bar (the kit's Page about): what's read now and then rather than acted
 * on. The kit it hands out, and Found on this PC with nothing to offer (the last stage is on the page). No tour names: the tour shows the page.
 */
export function StewardAbout({ v }: { v: StewardView }) {
  const now = useNow();
  if (v.off) return null;
  const s = v.staff;
  const castellan = v.castellan !== false;
  return (
    <>
      <style>{STYLE}</style>
      {/* With no employees and no repositories here it hands the kit to no one: it keeps it to run on. */}
      {castellan && (
        <Section title="The kit">
          <KitCard s={s} now={now} handsOut={!(v.round.repos === false && !s?.rows.length)} />
        </Section>
      )}
      {v.found && !foundOnPage(v.found) && <FoundCard f={v.found} finding={!!v.finding} now={now} />}
    </>
  );
}
