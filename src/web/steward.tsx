import { useState, type ReactNode } from 'react';
import { ago, Badge, Card, Notes, PostButton, Section, Text, useNow, type BadgeTone } from '../kit/react/index.ts';
import type { Alarm, AlarmState } from '../alarms.ts';
import type { TendState } from '../tend.ts';
import type { TurnsView } from '../lease.ts';
import type { EmployeeResult, StageResult } from '../stages/common.ts';
import type { FoundView, PrView, RoundView, StaffRowView, StaffView, StewardView } from './types.ts';

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

/** The Steward's PRs and the team's: a team member's says whose, and what it is. */
function Pr({ p, branch }: { p: PrView; branch: string }) {
  const team = p.whose === 'team';
  return (
    <div className="pr">
      <Link url={p.url}>#{p.number}</Link>
      {team && (
        <>
          {' '}
          <Badge title={`Opened by ${p.author}: merged by "Merge the team's PRs", or merge --team`} label="team" />
        </>
      )}{' '}
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
      {team && (
        <>
          <br />
          <span className="pr-title">{p.title}</span>
        </>
      )}
      {/* What it asks for once merged (its steward block), or why that can't be read. */}
      {p.afterError ? (
        <>
          <br />
          <Badge tone="danger" title={p.afterError} label="steward block" />
        </>
      ) : p.afterText ? (
        <>
          <br />
          <Text variant="muted">then: {p.afterText}</Text>
        </>
      ) : null}
      <br />
      <Text variant="muted">
        {p.head}
        {team ? `, ${p.author}'s` : ''}
      </Text>
    </div>
  );
}

/** What Settings let the Steward do with a repository: merge its ready PRs, release it. Off until the person says yes. */
function Allowed({ r }: { r: StaffRowView }) {
  return (
    <>
      <Badge tone={r.merges ? 'success' : 'neutral'} title={r.merges ? 'Merges your ready PRs to it' : 'Its PRs are left to you: switch on "Merges your ready PRs" for it in Settings'} label={r.merges ? 'merges' : 'PRs left to you'} />{' '}
      <Badge tone={r.releases ? 'success' : 'neutral'} title={r.releases ? 'Releases each new version on its branch' : 'Not released by the Steward: Settings name no way to (Release it)'} label={r.releases ? 'releases' : 'not released'} />
    </>
  );
}

/** One repository's row: its repository, checkout, branch, kit (on Castellan's own PC), release, open PRs and notes. */
function StaffRow({ r, kit, castellan }: { r: StaffRowView; kit: string | null; castellan: boolean }) {
  const co = r.checkout;
  const notes = r.notes.filter((n) => n !== 'not using the kit yet');
  return (
    <tr>
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
      <td>
        {r.prs.map((p) => (
          <Pr key={p.number} p={p} branch={r.branch} />
        ))}
        {r.prepared && (
          <>
            <code>{r.prepared.branch}</code>
            <br />
            <Text variant="muted">{r.prepared.ahead} ahead, not pushed?</Text>
          </>
        )}
      </td>
      <td>{notes.length > 0 && <Notes items={notes} />}</td>
    </tr>
  );
}

function StaffTable({ s, castellan }: { s: StaffView; castellan: boolean }) {
  if (!s.rows.length)
    return (
      <Card className="empty" tour="staff">
        No repositories yet. Pick the ones to look after from those Reeve found, above, or add one in Settings, under
        Repositories: its GitHub repository (owner/name), your clone of it, and how to test and release it.
      </Card>
    );
  return (
    <Card tour="staff">
      <table>
        <thead>
          <tr>
            {[castellan ? 'Employee' : 'Repository', 'Checkout', 'Branch on origin', ...(castellan ? ['Kit'] : []), 'Latest release', 'Open PRs', 'Notes'].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {s.rows.map((r) => (
            <StaffRow key={r.id} r={r} kit={s.kit} castellan={castellan} />
          ))}
        </tbody>
      </table>
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
      <Card className="empty" tour="last-stage">
        No stage has run yet.
      </Card>
    );
  const asked = Object.entries(l.asked)
    .filter(([, v]) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(',') : v}`)
    .join('; ');
  return (
    <Card tour="last-stage">
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

/**
 * What a round does, and when it comes, in words: the round line, and the question Run now asks. With no repositories
 * here (steward.ts's reposHere) a round only keeps the staff's pages up (tend.ts), or, with that off, has nothing to do.
 */
export function roundWords(r: RoundView, now = Date.now()): { what: string; when: string } {
  const more = [r.releaseSelf ? 'releases its own new versions' : '', r.rollout ? 'rolls a new kit out to each employee behind it' : ''].filter(Boolean);
  const repoWork =
    r.castellan === false
      ? 'merges each ready PR of yours in the repositories you said yes to (Merges your ready PRs), with what each asks for after, then releases each new version on a branch, where Settings say how'
      : `merges every PR of its own and the team's that is ready, with what each asks for after, then releases each employee whose branch carries a version with no release, ${more.length ? `${more.join(', ')}, ` : ''}and approves the jobs whose installed scripts are the merged ones`;
  const tend = "opens again, through Manor, the page of any agent that is on duty but doesn't answer";
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
        ? `It merges and releases only when asked, until you say yes: "Merges and releases by itself" is off in Settings. A round every ${r.minutes} minutes while on duty only ${tend}.${after} Run now does a whole round.`
        : 'It merges and releases only when asked, until you say yes: "Merges and releases by itself" is off in Settings. Run now does one round.'
      : `By itself, a round every ${r.minutes} minutes while on duty: it ${what}.${after}`;
  return { what, when };
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
export function RunNow({ v }: { v: StewardView }) {
  return (
    <PostButton title="Run now" variant="secondary" path="/api/run" confirm={`A round now: it ${roundWords(v.round).what}?`} disabled={!!v.running} />
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

/**
 * Turns with the licence's other PCs (lease.ts): each repository another PC merges and releases, with Do it here; and,
 * while the Exchequer can't be reached, that this PC goes on only where it had its turn.
 */
export function TurnsCard({ t }: { t: TurnsView | null | undefined }) {
  if (!t || (t.mode === 'on' && !t.elsewhere.length)) return null;
  return (
    <Section title="Your other PCs" count={t.elsewhere.length || undefined}>
      <Card>
        {t.mode === 'unreachable' && (
          <Text variant="muted" as="p">
            The Exchequer can't be reached just now, so this PC merges and releases only where it already had its turn, until that turn runs out.
          </Text>
        )}
        {t.elsewhere.map((x) => (
          <div className="row turn" key={x.id}>
            <span>
              Merging and releasing for {x.name}: done by <strong>{x.holder}</strong>
            </span>
            <PostButton
              title="Do it here"
              variant="secondary"
              path="/api/turns/take"
              body={{ repo: x.repo }}
              confirm={`Merge and release ${x.name} on this PC from now on? ${x.holder} leaves it alone from its next round.`}
            />
          </div>
        ))}
      </Card>
    </Section>
  );
}

/** The stages, for the ticked employees: one that doesn't take the kit starts unticked. */
function Stages({ v }: { v: StewardView }) {
  const s = v.staff;
  const kit = s?.kit ?? null;
  const rows = s?.rows ?? [];
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const castellan = v.castellan !== false;
  const isTicked = (r: StaffRowView) => ticked[r.id] ?? (castellan ? r.usesKit : true);
  const ask = () => ({ kit: kit ?? '', employees: rows.filter(isTicked).map((r) => r.id) });
  const onKit = rows.filter((r) => r.usesKit);
  const offKit = rows.filter((r) => !r.usesKit);
  const who = `the ticked employees (${onKit.length} take the kit)`;
  const noKit = !!v.running || !kit;
  const team = v.team;
  const teamAsk = `Merge the open PRs the team opened (${team.join(', ')}), and the Steward's, for the ticked employees: those that merge cleanly into the employee's branch and have no failing or running checks, with merge commits? Then each merged PR's steps from its steward block: release, install, and approving the jobs it names (merging counts as reading their scripts). The team's branches are left as they are.`;
  const one = offKit.length === 1;
  const offKitNote = offKit.length ? ` ${offKit.map((r) => r.name).join(' and ')} ${one ? "doesn't" : "don't"} take the kit yet: the stages pass over ${one ? 'it' : 'them'}, but the team's PRs to ${one ? 'it' : 'them'} can be merged.` : '';
  const stage = (label: string, path: string, confirm: string, disabled: boolean, tooltip?: string) => (
    <PostButton title={label} path={`/api/stage/${path}`} body={ask} confirm={confirm} disabled={disabled} tooltip={tooltip} />
  );
  if (!castellan) {
    const mine = `Merge your open PRs (${team.join(', ')}) to the ticked repositories you said yes to (Merges your ready PRs, in Settings): those that merge cleanly into the branch and have no failing or running checks, with merge commits? One with no checks on GitHub is tested here first. Then what each merged PR's steward block asks for. Your branches are left as they are.`;
    return (
      <Card tour="stages">
        <div className="picks">
          {rows.map((r) => (
            <label key={r.id} className="pick">
              <input type="checkbox" name="employees" value={r.id} checked={isTicked(r)} onChange={(e) => setTicked({ ...ticked, [r.id]: e.target.checked })} /> {r.name}
            </label>
          ))}
        </div>
        <div className="row stages">
          {stage('Merge your ready PRs', 'merge-team', mine, !!v.running || !team.length, v.teamNote ?? (team.length ? undefined : 'No team in Settings'))}
          {stage('Release', 'release', 'Release each ticked repository whose branch carries a version with no release yet, the way Settings say for it?', !!v.running)}
          <PostButton title={v.refreshing ? 'Refreshing…' : 'Refresh'} variant="secondary" icon="refresh" path="/api/staff/refresh" disabled={!!v.running || v.refreshing} />
        </div>
        <Text variant="muted" as="p">
          Each asks first, works through the ticked repositories, and reports for each below. Nothing is merged in a repository until you say yes for it, nor released until Settings say how.{v.teamNote ? ` ${v.teamNote}` : ''}
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
        {rows.map((r) => (
          <label key={r.id} className="pick" title={r.usesKit ? undefined : "Doesn't take the kit yet: only the team's PRs are merged for it"}>
            <input type="checkbox" name="employees" value={r.id} checked={isTicked(r)} onChange={(e) => setTicked({ ...ticked, [r.id]: e.target.checked })} /> {r.name}
          </label>
        ))}
      </div>
      <div className="row stages">
        {stage('1. Bump', 'bump', `Bump ${who} to kit ${kit}? For each: a worktree of its branch, kit.json pinned to ${kit}, its patch version up, its kit filled and its checks run, then a commit. Nothing is pushed.`, noKit)}
        {stage('2. Push', 'push', `Push the bumps to kit ${kit} and open their PRs? Nothing is force-pushed.`, noKit)}
        {stage('3. Merge', 'merge', "Merge the Steward's PRs that merge cleanly and have no failing or running checks, with merge commits? Then any steps a merged PR's steward block asks for.", !!v.running)}
        {stage('4. Release', 'release', `Release each ticked employee whose branch has kit ${kit} and an unreleased version, from that branch?`, noKit)}
        {stage("Merge the team's PRs", 'merge-team', teamAsk, !!v.running || !team.length, v.teamNote ?? (team.length ? undefined : 'No team in Settings'))}
        <PostButton title={v.refreshing ? 'Refreshing…' : 'Refresh'} variant="secondary" icon="refresh" path="/api/staff/refresh" disabled={!!v.running || v.refreshing} />
      </div>
      <Text variant="muted" as="p">
        Each stage asks first, works through the ticked employees, and reports for each below. Merge takes only the Steward's PRs; Merge the team's PRs takes those the team opened as well (Team, in Settings).{v.teamNote ? ` ${v.teamNote}` : ''}{offKitNote}
      </Text>
      <div className="row round">
        <Text variant="muted">{roundWords(v.round).when}</Text>
      </div>
    </Card>
  );
}

/**
 * The repositories Reeve found on this PC that you can push to and the Steward doesn't look after yet (found.ts), each
 * with Look after: added to Settings with merging and releasing as ticked here, both off unless you tick them.
 */
function FoundCard({ f, finding, now }: { f: FoundView | undefined; finding: boolean; now: number }) {
  const [asked, setAsked] = useState<Record<string, { merges: boolean; release: boolean }>>({});
  if (!f) return null;
  const of = (repo: string) => asked[repo] ?? { merges: false, release: false };
  const set = (repo: string, k: 'merges' | 'release', on: boolean) => setAsked({ ...asked, [repo]: { ...of(repo), [k]: on } });
  return (
    <Section title="Found on this PC" count={f.offered.length || undefined}>
      <Card tour="found">
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
              Your repositories on GitHub that Reeve found here and you can push to. Look after one to have its versions claimed, and its PRs and releases watched. It merges your ready PRs, or releases its new versions, only if you tick that.
            </Text>
            <table>
              <tbody>
                {f.offered.map((r) => (
                  <tr key={r.repo}>
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
                        <input type="checkbox" checked={of(r.repo).merges} onChange={(e) => set(r.repo, 'merges', e.target.checked)} /> Merge my ready PRs
                      </label>
                      <br />
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
.stages { margin-bottom: 6px; }
.round { gap: 10px; align-items: center; justify-content: space-between; margin-top: 8px; }
.pr + .pr { margin-top: 6px; }
.alarms { border-left: 3px solid var(--alert, #c0392b); }
.alarm + .alarm, .alarm + details, details + details { margin-top: 10px; }
.alarm-head { justify-content: space-between; align-items: center; gap: 10px; }
.turn { justify-content: space-between; align-items: center; gap: 10px; padding: 4px 0; }
.alarm .notes { margin: 4px 0; }
.pr-title { font-size: 13px; }
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
      <Card tour="kit">
        <p>
          The kit the Steward manages: <strong>{s.kit ?? s.local ?? 'none'}</strong>
        </p>
        <Text variant="muted" as="p">
          With no repositories to look after here, it hands the kit to no one: it keeps it only to run on itself.
        </Text>
      </Card>
    );
  return (
    <Card tour="kit">
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

/** The page's body: everything above Settings. */
export function StewardBody({ v }: { v: StewardView }) {
  const now = useNow();
  const s = v.staff;
  const castellan = v.castellan !== false;
  return (
    <>
      <style>{STYLE}</style>
      {v.running && (
        <Card className="row">
          <Badge tone="caution" label="Working" />{' '}
          <span>
            {v.running.stage}, started {ago(v.running.since, now)}. This page keeps itself current until it's done.
          </span>
        </Card>
      )}
      <AlarmsCard a={v.alarms} now={now} />
      <TurnsCard t={v.turns} />
      {v.round.repos === false && (
        <Card>
          <Text variant="muted" as="p">
            {roundWords(v.round, now).when}
          </Text>
        </Card>
      )}
      <TendingCard t={v.tending} r={v.round} now={now} />
      {/* With no employees and no repositories here it hands the kit to no one: it keeps it to run on. */}
      {castellan && <KitCard s={s} now={now} handsOut={!(v.round.repos === false && !s?.rows.length)} />}
      <FoundCard f={v.found} finding={!!v.finding} now={now} />
      <Section title={castellan ? 'Staff' : 'Your repositories'} count={s?.rows.length}>
        {s ? <StaffTable s={s} castellan={castellan} /> : <Card className="empty">Looking at each repository…</Card>}
      </Section>
      {(s?.rows.length ?? 0) > 0 && (
        <Section title={castellan ? 'Roll out the kit' : 'Merge and release'}>
          <Stages v={v} />
        </Section>
      )}
      <Section title="Last stage">
        <LastStage l={v.last} now={now} />
      </Section>
    </>
  );
}
