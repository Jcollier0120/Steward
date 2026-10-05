import { useState, type ReactNode } from 'react';
import { ago, Badge, Card, Muted, Notes, PostButton, useNow } from '../kit/react/index.ts';
import type { Alarm, AlarmState } from '../alarms.ts';
import type { EmployeeResult, StageResult } from '../stages/common.ts';
import type { PrView, RoundView, StaffRowView, StaffView, StewardView } from './types.ts';

/** The Steward's page: the kit, the staff's table, the stages, the last stage. (Settings is the kit's: shell.tsx.) */

const Link = ({ url, children }: { url: string; children: ReactNode }) => (
  <a href={url} rel="noreferrer">
    {children}
  </a>
);

function KitCell({ r, kit }: { r: StaffRowView; kit: string | null }) {
  if (!r.usesKit) return <Badge>not using the kit yet</Badge>;
  const m = r.main;
  if (!m) return <Muted>unknown</Muted>;
  if (m.oldKitFiles.length)
    return (
      <Badge kind="alert" title={`Still tracks ${m.oldKitFiles.length} old kit files at their old paths: ${m.oldKitFiles.join(', ')}`}>
        old kit
      </Badge>
    );
  if (!m.kit) return <Badge kind="warn">no kit.json</Badge>;
  return (
    <Badge kind={m.kit === kit ? 'ok' : 'warn'} title={m.parts ? `parts: ${m.parts.join(', ')}` : undefined}>
      kit {m.kit}
    </Badge>
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
          <Muted>{kit}</Muted>
        </>
      ) : (
        <Muted>none</Muted>
      )}
      {r.releaseNeeded && r.main?.version && (
        <>
          <br />
          <Badge kind="warn">{r.main.version} not released</Badge>
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
          <Badge title={`Opened by ${p.author}: merged by "Merge the team's PRs", or merge --team`}>team</Badge>
        </>
      )}{' '}
      <Badge kind={p.checks === 'failing' ? 'alert' : p.checks === 'pending' ? 'warn' : 'ok'}>checks {p.checks}</Badge>{' '}
      <Badge kind={p.mergeable === 'MERGEABLE' ? 'ok' : p.mergeable === 'CONFLICTING' ? 'alert' : 'warn'}>{p.mergeable.toLowerCase()}</Badge>
      {p.draft && (
        <>
          {' '}
          <Badge kind="warn">draft</Badge>
        </>
      )}
      {p.base && p.base !== branch && (
        <>
          {' '}
          <Badge kind="warn" title={`Merge only takes a PR into ${branch}`}>
            into {p.base}
          </Badge>
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
          <Badge kind="alert" title={p.afterError}>
            steward block
          </Badge>
        </>
      ) : p.afterText ? (
        <>
          <br />
          <Muted>then: {p.afterText}</Muted>
        </>
      ) : null}
      <br />
      <Muted>
        {p.head}
        {team ? `, ${p.author}'s` : ''}
      </Muted>
    </div>
  );
}

/** One employee's row: its repository, checkout, branch, kit, release, open PRs and notes. */
function StaffRow({ r, kit }: { r: StaffRowView; kit: string | null }) {
  const co = r.checkout;
  const notes = r.notes.filter((n) => n !== 'not using the kit yet');
  return (
    <tr>
      <td>
        <strong>
          <Link url={`https://github.com/${r.repo}`}>{r.name}</Link>
        </strong>
        <br />
        <Muted>{r.parts.join(', ') || 'no parts'}</Muted>
      </td>
      <td>
        {co.exists ? (
          <>
            <code>{co.path}</code>
            <br />
            <Muted>
              {co.branch ?? ''}
              {co.changes ? `, ${co.changes} changed` : ''}
            </Muted>
          </>
        ) : (
          <>
            <Muted>no checkout at</Muted> <code>{co.path}</code>
          </>
        )}
      </td>
      <td>
        {r.main ? (
          <>
            {r.branch} {r.main.version ?? '?'} <Muted>{r.main.commit}</Muted>
          </>
        ) : (
          <Muted>unknown</Muted>
        )}
      </td>
      <td>
        <KitCell r={r} kit={kit} />
      </td>
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
            <Muted>{r.prepared.ahead} ahead, not pushed?</Muted>
          </>
        )}
      </td>
      <td>{notes.length > 0 && <Notes items={notes} />}</td>
    </tr>
  );
}

function StaffTable({ s }: { s: StaffView }) {
  return (
    <Card tour="staff">
      <table>
        <thead>
          <tr>
            {['Employee', 'Checkout', 'Branch on origin', 'Kit', 'Latest release', 'Open PRs', 'Notes'].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {s.rows.map((r) => (
            <StaffRow key={r.id} r={r} kit={s.kit} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

const OUTCOME: Record<EmployeeResult['outcome'], 'ok' | '' | 'warn' | 'alert'> = { done: 'ok', skipped: '', refused: 'warn', failed: 'alert' };

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
            <Muted>({asked})</Muted>
          </>
        )}
      </p>
      {l.error && (
        <p>
          <Badge kind="alert">stopped</Badge> {l.error}
        </p>
      )}
      {l.results.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Result</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {l.results.map((r, i) => (
              <tr key={i}>
                <td>{r.name}</td>
                <td>
                  <Badge kind={OUTCOME[r.outcome]}>{r.outcome}</Badge>
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
      )}
      <details open={!!l.error || l.results.some((r) => r.outcome === 'failed')}>
        <summary>Log ({l.log.length} lines)</summary>
        <pre className="log">{l.log.join('\n')}</pre>
      </details>
    </Card>
  );
}

/** What a round does, and when it comes, in words: the round line, and the question Run now asks. */
export function roundWords(r: RoundView, now = Date.now()): { what: string; when: string } {
  const more = [r.releaseSelf ? 'releases its own new versions' : '', r.rollout ? 'rolls a new kit out to each employee behind it' : ''].filter(Boolean);
  const what = `merges every PR of its own and the team's that is ready, with what each asks for after, then releases each employee whose branch carries a version with no release, ${more.length ? `${more.join(', ')}, ` : ''}and approves the jobs whose installed scripts are the merged ones`;
  const when = !r.on
    ? 'It merges and releases only when asked: "Merges and releases by itself" is off in Settings. Run now does one round.'
    : `By itself, a round every ${r.minutes} minutes while on duty: it ${what}.${r.onDuty ? '' : ' Off duty, the rounds wait.'}${r.lastRunAt ? ` The last ended ${ago(r.lastRunAt, now)}.` : ''}`;
  return { what, when };
}

/** Run now, in the title bar: a round now, on duty or not, asked first. */
export function RunNow({ v }: { v: StewardView }) {
  return (
    <PostButton quiet path="/api/run" confirm={`A round now: it ${roundWords(v.round).what}?`} disabled={!!v.running}>
      Run now
    </PostButton>
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
        {button && (
          <PostButton quiet path="/api/alarms/dismiss" body={{ id: x.id }}>
            Dismiss
          </PostButton>
        )}
      </div>
      {x.detail.length > 0 && <Notes items={x.detail} />}
      <Muted>
        Since {ago(x.since, now)}
        {x.dismissedAt ? `, dismissed ${ago(x.dismissedAt, now)}` : ''}
      </Muted>
    </div>
  );
  if (!showing.length && !dismissed.length && !a.cleared.length) return null;
  return (
    <>
      <a id="alarms" />
      {showing.length > 0 && <h2>Needs you</h2>}
      <Card className={showing.length ? 'alarms' : undefined} tour="alarms">
        {showing.length ? showing.map((x) => item(x, true)) : <Muted as="p">Nothing needs you.</Muted>}
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
                  {x.title} <Muted>(cleared {ago(x.clearedAt, now)})</Muted>
                </>
              ))}
            />
          </details>
        )}
      </Card>
    </>
  );
}

/** The stages, for the ticked employees: one that doesn't take the kit starts unticked. */
function Stages({ v }: { v: StewardView }) {
  const s = v.staff;
  const kit = s?.kit ?? null;
  const rows = s?.rows ?? [];
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const isTicked = (r: StaffRowView) => ticked[r.id] ?? r.usesKit;
  const ask = () => ({ kit: kit ?? '', employees: rows.filter(isTicked).map((r) => r.id) });
  const onKit = rows.filter((r) => r.usesKit);
  const offKit = rows.filter((r) => !r.usesKit);
  const who = `the ticked employees (${onKit.length} take the kit)`;
  const noKit = !!v.running || !kit;
  const team = v.team;
  const teamAsk = `Merge the open PRs the team opened (${team.join(', ')}), and the Steward's, for the ticked employees: those that merge cleanly into the employee's branch and have no failing or running checks, with merge commits? Then each merged PR's steps from its steward block: release, install, and approving the jobs it names (merging counts as reading their scripts). The team's branches are left as they are.`;
  const one = offKit.length === 1;
  const offKitNote = offKit.length ? ` ${offKit.map((r) => r.name).join(' and ')} ${one ? "doesn't" : "don't"} take the kit yet: the stages pass over ${one ? 'it' : 'them'}, but the team's PRs to ${one ? 'it' : 'them'} can be merged.` : '';
  const stage = (label: string, path: string, confirm: string, disabled: boolean, title?: string) => (
    <PostButton path={`/api/stage/${path}`} body={ask} confirm={confirm} disabled={disabled} title={title}>
      {label}
    </PostButton>
  );
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
        {stage("Merge the team's PRs", 'merge-team', teamAsk, !!v.running || !team.length, team.length ? undefined : 'No team in Settings')}
        <PostButton quiet path="/api/staff/refresh" disabled={!!v.running || v.refreshing}>
          {v.refreshing ? 'Refreshing…' : 'Refresh'}
        </PostButton>
      </div>
      <Muted as="p">
        Each stage asks first, works through the ticked employees, and reports for each below. Merge takes only the Steward's PRs; Merge the team's PRs takes those the team opened as well (Team, in Settings).{offKitNote}
      </Muted>
      <div className="row round">
        <Muted>{roundWords(v.round).when}</Muted>
      </div>
    </Card>
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
.alarm .notes { margin: 4px 0; }
.pr-title { font-size: 13px; }
pre.log { max-height: 420px; overflow: auto; font: 12px/1.45 "Cascadia Mono", Consolas, monospace; white-space: pre-wrap; background: var(--bg); padding: 8px; border-radius: 6px; }
td a { color: var(--accent); }
`;

/** The page's body: everything above Settings. */
export function StewardBody({ v }: { v: StewardView }) {
  const now = useNow();
  const s = v.staff;
  return (
    <>
      <style>{STYLE}</style>
      {v.running && (
        <Card className="row">
          <Badge kind="warn">Working</Badge>{' '}
          <span>
            {v.running.stage}, started {ago(v.running.since, now)}. This page keeps itself current until it's done.
          </span>
        </Card>
      )}
      <AlarmsCard a={v.alarms} now={now} />
      <Card tour="kit">
        {s ? (
          <>
            <p>
              The kit the Steward hands out: <strong>{s.kit ?? 'none'}</strong>
              {s.released.length > 0 && (
                <>
                  {' '}
                  <Muted>(released: {s.released.slice(0, 5).join(', ')})</Muted>
                </>
              )}
              {s.local && (
                <>
                  {' '}
                  <Muted>· this checkout's kit\VERSION: {s.local}</Muted>
                </>
              )}
            </p>
            {s.kitNote && <Muted as="p">{s.kitNote}</Muted>}
            <Muted as="p">
              The table is from {ago(s.at, now)}
              {s.checked && s.checked !== s.at ? `; GitHub had nothing new for it ${ago(s.checked, now)}` : ''}.
            </Muted>
          </>
        ) : (
          <Muted as="p">Looking at the staff for the first time…</Muted>
        )}
      </Card>
      <h2>Staff</h2>
      {s ? <StaffTable s={s} /> : <Card className="empty">Looking at each employee…</Card>}
      <h2>Roll out the kit</h2>
      <Stages v={v} />
      <h2>Last stage</h2>
      <LastStage l={v.last} now={now} />
    </>
  );
}
