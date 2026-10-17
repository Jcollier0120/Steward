import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ago, Badge, Card, Notes, PostButton, Section, Text, useNow, type BadgeTone } from '../kit/react/index.ts';
import type { Alarm, AlarmState } from '../alarms.ts';
import type { TendState } from '../tend.ts';
import type { TurnRow, TurnsView } from '../lease.ts';
import type { Host } from '../scm.ts';
import type { EmployeeResult, StageResult } from '../stages/common.ts';
import type { WholeJob } from '../stages/wholesuite.ts';
import type { FoundView, PrView, RoundView, StaffRowView, StaffView, StewardView } from './types.ts';
import { askedWords } from './asked.ts';

/** The Steward's page: the kit, the staff's table, the stages, the last stage. (Settings is the kit's: shell.tsx.) */

const Link = ({ url, children }: { url: string; children: ReactNode }) => (
  <a href={url} rel="noreferrer">
    {children}
  </a>
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

function ReleaseCell({ r }: { r: StaffRowView }) {
  const rel = r.release;
  const kit = !rel ? '' : rel.kit === 'unknown' ? '' : rel.kit ? `, kit ${rel.kit}` : ', no kit';
  return (
    <>
      {rel ? (
        <>
          <Link url={`https://github.com/${r.repo}/releases/tag/${rel.tag}`}>{rel.tag}</Link>
          <Text variant="muted">{kit}</Text>
        </>
      ) : (
        <Text variant="muted">none</Text>
      )}
      {r.releaseNeeded && r.main?.version && (
        <>
          <br />
          <Badge tone="caution" label={<>{r.main.version} not released</>} />
        </>
      )}
    </>
  );
}

/** One of the Steward's PRs or the team's, as a line of its repository's PR table: a team member's says whose. */
function Pr({ p, branch }: { p: PrView; branch: string }) {
  const team = p.whose === 'team';
  return (
    <tr>
      <td className="pr-num">
        <Link url={p.url}>#{p.number}</Link>
        {team && (
          <>
            {' '}
            <Badge title={`Opened by ${p.author}: whoever opened it merges it once it is vouched`} label="team" />
          </>
        )}
      </td>
      <td>
        {p.title}
        <br />
        <Text variant="muted">
          {p.head}
          {team ? `, ${p.author}'s` : ''}
        </Text>
        {/* What it asks for once merged (its steward block), or why that can't be read. */}
        {p.afterError ? (
          <>
            {' '}
            <Badge tone="danger" title={p.afterError} label="steward block" />
          </>
        ) : p.afterText ? (
          <>
            <br />
            <Text variant="muted">then: {p.afterText}</Text>
          </>
        ) : null}
      </td>
      <td className="pr-state">
        <Badge tone={p.checks === 'failing' ? 'danger' : p.checks === 'pending' ? 'caution' : 'success'} label={<>checks {p.checks}</>} />{' '}
        <Badge tone={p.mergeable === 'MERGEABLE' ? 'success' : p.mergeable === 'CONFLICTING' ? 'danger' : 'caution'} label={p.mergeable.toLowerCase()} />
        {p.draft && (
          <>
            {' '}
            <Badge tone="caution" label="draft" />
          </>
        )}
        {p.base && p.base !== branch && (
          <>
            {' '}
            <Badge tone="caution" title={`Merge only takes a PR into ${branch}`} label={<>into {p.base}</>} />
          </>
        )}
      </td>
    </tr>
  );
}

/** What each host calls a PR, for the heading over a repository's: GitLab's are merge requests. Plain git has none. */
const PRS_CALLED: Record<Host, string> = { github: 'Pull requests', gitlab: 'Merge requests', azure: 'Pull requests', gitea: 'Pull requests', bitbucket: 'Pull requests', git: 'Branches' };

/** A repository's open PRs under a small heading in its host's words, and a branch prepared here and not pushed, as a small table under its row. */
function PrTable({ r }: { r: StaffRowView }) {
  return (
    <>
      {r.prs.length > 0 && <div className="pr-head">{PRS_CALLED[r.host ?? 'github']}</div>}
      <table className="pr-table">
        <tbody>
          {r.prs.map((p) => (
            <Pr key={p.number} p={p} branch={r.branch} />
          ))}
          {r.prepared && (
            <tr>
              <td colSpan={3}>
                <code>{r.prepared.branch}</code> <Text variant="muted">{r.prepared.ahead} ahead, not pushed?</Text>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
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
 * One repository's row: its repository, checkout, branch, kit (on Castellan's own PC), release, release PC and notes
 * (`notes` false: no row has any, so no column). Its open PRs, when it has some, in a small table on a line under it.
 */
function StaffRow({ r, kit, castellan, turn, notes: notesColumn }: { r: StaffRowView; kit: string | null; castellan: boolean; turn?: TurnRow | null; notes: boolean }) {
  const co = r.checkout;
  const notes = shownNotes(r);
  const hasPrs = r.prs.length > 0 || !!r.prepared;
  const rest = (castellan ? 2 : 1) + (turn !== undefined ? 1 : 0) + (notesColumn ? 1 : 0);
  return (
    <>
      <tr className={hasPrs ? 'has-prs' : undefined}>
        <td>
          <strong>
            <Link url={`https://github.com/${r.repo}`}>{r.name}</Link>
          </strong>
          <br />
          {castellan ? <Text variant="muted">{r.main?.parts?.join(', ') || 'no parts'}</Text> : <Allowed r={r} />}
        </td>
        <td>
          {co.exists ? (
            <>
              <code>{co.path}</code>
              <br />
              <Text variant="muted">
                {co.branch ?? ''}
                {co.changes ? `, ${co.changes} changed` : ''}
              </Text>
            </>
          ) : (
            <>
              <Text variant="muted">no checkout at</Text> <code>{co.path}</code>
            </>
          )}
        </td>
        <td>
          {r.main ? (
            <>
              {r.branch} {r.main.version ?? '?'} <Text variant="muted">{r.main.commit}</Text>
            </>
          ) : (
            <Text variant="muted">unknown</Text>
          )}
        </td>
        {castellan && (
          <td>
            <KitCell r={r} kit={kit} />
          </td>
        )}
        <td>
          <ReleaseCell r={r} />
        </td>
        {turn !== undefined && <td>{turn && <TurnCell x={turn} />}</td>}
        {notesColumn && <td>{notes.length > 0 && <Notes items={notes} />}</td>}
      </tr>
      {hasPrs && (
        <tr className="prs-row">
          <td colSpan={3}>
            <PrTable r={r} />
          </td>
          <td colSpan={rest} />
        </tr>
      )}
    </>
  );
}

/**
 * The staff's table, with each repository's release PC (lease.ts) in it once a turn was taken: who merges and releases
 * it, with Do it here and Keep it on this PC. Turns for no row here, and claims another PC made too (claims.ts), under it.
 */
function StaffTable({ s, castellan, turns, clashes }: { s: StaffView | null; castellan: boolean; turns: TurnsView | null | undefined; clashes?: string[] }) {
  const rows = s?.rows ?? [];
  const turnOf = new Map((turns?.rows ?? []).map((x) => [x.id, x]));
  const loose = (turns?.rows ?? []).filter((x) => !rows.some((r) => r.id === x.id));
  const showTurns = rows.some((r) => turnOf.has(r.id));
  const showNotes = rows.some((r) => shownNotes(r).length > 0);
  const under = (loose.length > 0 || (clashes?.length ?? 0) > 0) && (
    <div className="turns">
      {loose.map((x) => (
        <TurnLine key={x.id} x={x} />
      ))}
      {(clashes ?? []).map((c) => (
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
        No repositories yet. Pick the ones to look after from those Reeve found, above, or add one in Settings, under
        Repositories: its GitHub repository (owner/name), your clone of it, and how to test and release it.
        {under}
      </Card>
    );
  return (
    <Card tour="staff">
      <table className="staff">
        <thead>
          <tr>
            {[castellan ? 'Employee' : 'Repository', 'Checkout', 'Branch on origin', ...(castellan ? ['Kit'] : []), 'Latest release', ...(showTurns ? ['Release PC'] : []), ...(showNotes ? ['Notes'] : [])].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <StaffRow key={r.id} r={r} kit={s.kit} castellan={castellan} turn={showTurns ? (turnOf.get(r.id) ?? null) : undefined} notes={showNotes} />
          ))}
        </tbody>
      </table>
      {under}
    </Card>
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
      {acted.length > 0 ? <ResultTable results={acted} /> : <Text variant="muted" as="p">Nothing to do for anyone.</Text>}
      {skipped.length > 0 && (
        <details>
          <summary>
            {skipped.length} skipped, with nothing to do
          </summary>
          <ResultTable results={skipped} />
        </details>
      )}
    </>
  );
}

function ResultTable({ results }: { results: StageResult['results'] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Employee</th>
          <th>Result</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {results.map((r, i) => (
          <tr key={i}>
            <td>{r.name}</td>
            <td>
              <Badge tone={OUTCOME[r.outcome]} label={r.outcome} />
            </td>
            <td>
              {r.message}
              {r.url && (
                <>
                  {' '}
                  <Link url={r.url}>link</Link>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LastStage({ l, now }: { l: StageResult | null; now: number }) {
  if (!l)
    return (
      <Card className="empty">
        No stage has run yet.
      </Card>
    );
  const asked = askedWords(l.asked);
  return (
    <Card>
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
      <details open={!!l.error || l.results.some((r) => r.outcome === 'failed')}>
        <summary>Log ({l.log.length} lines)</summary>
        <pre className="log">{l.log.join('\n')}</pre>
      </details>
    </Card>
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
  const tend = "opens again, through Manor, the page of any agent that is on duty but doesn't answer, and installs again, once, an update rolled back only because the PC was offline for a moment";
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
        ? `It builds at set times (${r.build.times.join(', ')}; Settings: Build pipeline): a build ${what}, each repository released once. ${r.build.building ? 'A build is under way now.' : r.build.next ? `The next build is at ${buildAt(r.build.next, now)}.` : 'No build time is set to come.'}${r.build.late ? ` ${r.build.late.charAt(0).toUpperCase()}${r.build.late.slice(1)}.` : ''}${r.build.wakes ? ' Plugged in, the PC is woken a few minutes before each build, and kept up until it closes.' : ''} Between builds, a round every ${r.minutes} minutes only looks, except for an urgent fix (a ready PR whose changelog entry starts "**Urgent fix:"): that builds at once, for its repository alone.${after}`
        : `By itself, a round every ${r.minutes} minutes while on duty: it ${what}.${after}`;
  // Where the last build's time went (buildtimes.ts), and that what is merged between builds is released at the next.
  const took = r.on && !noRepos && r.build?.took ? ` ${r.build.took} Between builds, whoever wrote a PR merges it once vouched, and the next build releases it.` : '';
  return { what, when: `${when}${took}` };
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

/** Run now, in the title bar: a round now, on duty or not, asked first. */
/** The stages running now, side by side; a page from a Steward before that gives only `running`. */
const runsOf = (v: StewardView) => v.runs ?? (v.running ? [v.running] : []);
/** No stage can start now: every slot taken (Settings' Stages at once); before slots, any one running. */
const noSlot = (v: StewardView) => v.full ?? !!v.running;

export function RunNow({ v }: { v: StewardView }) {
  if (v.off) return null;
  return (
    <PostButton title="Run now" variant="secondary" path="/api/run" confirm={`A round now: it ${roundWords(v.round).what}?`} disabled={noSlot(v) || runsOf(v).some((r) => r.stage === 'round')} />
  );
}

/** What needs the person (alarms.ts), at the top: each open one with its facts and a Dismiss; the dismissed and the lately cleared folded away. */
export function AlarmsCard({ a, now }: { a: AlarmState | undefined; now: number }) {
  if (!a) return null;
  const showing = a.open.filter((x) => !x.dismissedAt);
  const dismissed = a.open.filter((x) => x.dismissedAt);
  const item = (x: Alarm, button: boolean) => (
    <div className="alarm" key={x.id}>
      <div className="row alarm-head">
        <strong>{x.url ? <Link url={x.url}>{x.title}</Link> : x.title}</strong>
        {button && x.action && <PostButton title={x.action.label} path="/api/alarms/act" body={{ id: x.id }} confirm={x.action.confirm} />}
        {button && <PostButton title="Dismiss" variant="secondary" path="/api/alarms/dismiss" body={{ id: x.id }} />}
      </div>
      {x.detail.length > 0 && <Notes items={x.detail} />}
      <Text variant="muted">
        Since {ago(x.since, now)}
        {x.dismissedAt ? `, dismissed ${ago(x.dismissedAt, now)}` : ''}
      </Text>
    </div>
  );
  if (!showing.length && !dismissed.length && !a.cleared.length) return null;
  const card = (
    <Card className={showing.length ? 'alarms' : undefined} tour="alarms">
        {showing.length ? showing.map((x) => item(x, true)) : <Text variant="muted" as="p">Nothing needs you.</Text>}
        {dismissed.length > 0 && (
          <details>
            <summary className="muted">{dismissed.length} dismissed: back if they clear and return</summary>
            {dismissed.map((x) => item(x, false))}
          </details>
        )}
        {a.cleared.length > 0 && (
          <details>
            <summary className="muted">Lately cleared</summary>
            <Notes
              items={a.cleared.slice(0, 10).map((x) => (
                <>
                  {x.title} <Text variant="muted">(cleared {ago(x.clearedAt, now)})</Text>
                </>
              ))}
            />
          </details>
        )}
    </Card>
  );
  return (
    <>
      <a id="alarms" />
      {showing.length > 0 ? (
        <Section title="Needs you" count={showing.length}>
          {card}
        </Section>
      ) : (
        card
      )}
    </>
  );
}

/** A turn's buttons (lease.ts): on another PC, Do it here and Keep it on this PC; on this one, Keep it on this PC or Unpin. */
function TurnButtons({ x }: { x: TurnRow }) {
  if (x.status === 'elsewhere')
    return (
      <span className="row turn-buttons">
        <PostButton
          title="Do it here"
          variant="secondary"
          path="/api/turns/take"
          body={{ repo: x.repo }}
          confirm={`Merge and release ${x.name} on this PC from now on? ${x.holder} leaves it alone from its next look.`}
        />
        <PostButton
          title="Keep it on this PC"
          variant="secondary"
          path="/api/turns/take"
          body={{ repo: x.repo, pin: true }}
          confirm={`Merge and release ${x.name} on this PC, and keep it here? Other PCs leave it alone while this PC is around.`}
        />
      </span>
    );
  if (x.status === 'here')
    return x.pinned ? (
      <PostButton title="Unpin" variant="secondary" path="/api/turns/take" body={{ repo: x.repo, pin: false }} />
    ) : (
      <PostButton title="Keep it on this PC" variant="secondary" path="/api/turns/take" body={{ repo: x.repo, pin: true }} confirm={`Keep ${x.name} on this PC? Other PCs leave it alone while this PC is around.`} />
    );
  return null;
}

const sentence = (s: string | null) => (s ? `${s[0].toUpperCase()}${s.slice(1)}.` : '');

/** A repository's release PC, in its row of the staff's table: who merges and releases it, kept there or not, and the buttons. */
function TurnCell({ x }: { x: TurnRow }) {
  if (x.status === 'unreachable' || x.status === 'alone') return <Text variant="muted">{sentence(x.note)}</Text>;
  return (
    <>
      {x.status === 'here' ? 'this PC' : <strong>{x.holder}</strong>}
      {x.pinned ? <Text variant="muted"> (kept there)</Text> : null}
      {x.quiet ? (
        <>
          <br />
          <Text variant="muted">{`${x.holder} has gone quiet: after a day without it, another PC may take it`}</Text>
        </>
      ) : null}
      <div className="turn-cell">
        <TurnButtons x={x} />
      </div>
    </>
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
          Each asks first, works through the ticked repositories, and reports for each below. Nothing is released until Settings say how. The Steward merges no PRs: merge your own once vouched, and each build releases what is on the branch.
        </Text>
        <div className="row round">
          <Text variant="muted">{roundWords(v.round).when}</Text>
        </div>
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
        Each stage asks first, works through the ticked employees, and reports for each below. The Steward merges no one's PRs but its own kit PRs: each build merges those it rolls out, and releases each branch.{offKitNote}
      </Text>
      <div className="row round">
        <Text variant="muted">{roundWords(v.round).when}</Text>
      </div>
    </Card>
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
            {f.found ? 'Every repository Reeve found that you can push to is looked after already.' : 'Reeve found no repository on GitHub here.'}
          </Text>
        ) : (
          <>
            <Text variant="muted" as="p">
              Your repositories on GitHub that Reeve found here and you can push to. Look after one to have its versions claimed, and its PRs and releases watched, or tick several and look after them in one go. It releases its new versions only if you tick that; you merge your own PRs.{f.into === 'manor' ? " It goes into Manor's Repositories, the one list every agent reads: change or remove it there." : ''}
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
            <table>
              <tbody>
                {f.offered.map((r) => (
                  <tr key={r.repo}>
                    <td className="pick-cell">
                      <input type="checkbox" checked={!!picked[r.repo]} onChange={(e) => setPicked({ ...picked, [r.repo]: e.target.checked })} aria-label={`Pick ${r.repo}`} />
                    </td>
                    <td>
                      <strong>
                        <Link url={`https://github.com/${r.repo}`}>{r.repo}</Link>
                      </strong>
                      <br />
                      <Text variant="muted">
                        <code>{r.path}</code> {r.branch}
                      </Text>
                    </td>
                    <td>
                      <label className="pick">
                        <input type="checkbox" checked={of(r.repo).release} onChange={(e) => set(r.repo, 'release', e.target.checked)} /> Release each new version
                      </label>
                    </td>
                    <td>
                      <PostButton title="Look after" path="/api/repos/look-after" body={() => ({ repo: r.repo, ...of(r.repo) })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="row round">
          <Text variant="muted">{f.at ? `Looked ${ago(f.at, now)}${f.from === 'file' ? ", from Reeve's last scan" : ''}.` : ''}</Text>
          <PostButton title={finding ? 'Looking…' : 'Look again'} variant="secondary" icon="refresh" path="/api/repos/refresh" disabled={finding} />
        </div>
      </Card>
    </Section>
  );
}

/** The Steward's own styles, beside the kit's. */
const STYLE = `
.notes { margin: 0; padding-left: 16px; color: var(--muted); font-size: 13px; }
.picks { display: flex; gap: 6px 16px; flex-wrap: wrap; margin-bottom: 10px; }
.pick { display: inline-flex; gap: 6px; align-items: center; }
.pick-all { font-weight: 600; padding-right: 12px; border-right: 1px solid var(--line); }
.pick-bar { gap: 12px; align-items: center; margin: 8px 0; }
td.pick-cell { width: 1%; padding-right: 0; }
.stages { margin-bottom: 6px; }
.round { gap: 10px; align-items: center; justify-content: space-between; margin-top: 8px; }
.staff tr.has-prs > td { border-bottom: 0; }
.staff tr.prs-row > td { padding-top: 0; }
.pr-head { font-size: 12px; font-weight: 600; color: var(--muted); margin: 2px 0; }
.pr-table { font-size: 13px; }
.pr-table td { padding: 3px 12px 3px 0; border-bottom: 0; }
.pr-table .pr-num, .pr-table .pr-state { white-space: nowrap; }
.turn-cell button { white-space: nowrap; }
.alarms { border-left: 3px solid var(--alert, #c0392b); }
.alarm + .alarm, .alarm + details, details + details { margin-top: 10px; }
.alarm-head { justify-content: space-between; align-items: center; gap: 10px; }
.turn { justify-content: space-between; align-items: center; gap: 10px; padding: 4px 0; }
.turns { margin-top: 10px; }
.turn-cell { margin-top: 4px; }
.turn-buttons { gap: 6px; flex-wrap: wrap; }
.alarm .notes { margin: 4px 0; }
pre.log { max-height: 420px; overflow: auto; font: 12px/1.45 "Cascadia Mono", Consolas, monospace; white-space: pre-wrap; background: var(--bg); padding: 8px; border-radius: 6px; }
td a { color: var(--accent); }
`;

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
            {s.checked && s.checked !== s.at ? `; GitHub had nothing new for it ${ago(s.checked, now)}` : ''}.
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
      {/* What it did last, first: the quickest way to see what is going on. Its log stays folded unless it stopped. */}
      <Section title="Last stage" tour="last">
        <LastStage l={v.last} now={now} />
      </Section>
      <TendingCard t={v.tending} r={v.round} now={now} />
      {foundOnPage(v.found) && <FoundCard f={v.found} finding={!!v.finding} now={now} tour="found" />}
      <Section title={castellan ? 'Staff' : 'Your repositories'} count={s?.rows.length}>
        <StaffTable s={s} castellan={castellan} turns={v.turns} clashes={v.claimClashes} />
      </Section>
      {hasEmployees(v) && (
        <Section title={castellan ? 'Roll out the kit' : 'Release'}>
          <Stages v={v} />
        </Section>
      )}
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
