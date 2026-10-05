import { useState, type ReactNode } from 'react';
import { ago, Badge, Card, Notes, PostButton, Section, Text, useNow, type BadgeTone } from '../kit/react/index.ts';
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
  if (!r.usesKit) return <Badge label="not using the kit yet" />;
  const m = r.main;
  if (!m) return <Text variant="muted">unknown</Text>;
  if (m.oldKitFiles.length)
    return (
      <Badge tone="danger" title={`Still tracks ${m.oldKitFiles.length} old kit files at their old paths: ${m.oldKitFiles.join(', ')}`} label="old kit" />
    );
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
        <Text variant="muted">{r.parts.join(', ') || 'no parts'}</Text>
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
            <Text variant="muted">{r.prepared.ahead} ahead, not pushed?</Text>
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

const OUTCOME: Record<EmployeeResult['outcome'], BadgeTone> = { done: 'success', skipped: 'neutral', refused: 'caution', failed: 'danger' };

/** A stage's result for each employee: how it went, in what words, and a link when there is one. */
function StageResults({ results }: { results: StageResult['results'] }) {
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
  const stage = (label: string, path: string, confirm: string, disabled: boolean, tooltip?: string) => (
    <PostButton title={label} path={`/api/stage/${path}`} body={ask} confirm={confirm} disabled={disabled} tooltip={tooltip} />
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
        <PostButton title={v.refreshing ? 'Refreshing…' : 'Refresh'} variant="secondary" icon="refresh" path="/api/staff/refresh" disabled={!!v.running || v.refreshing} />
      </div>
      <Text variant="muted" as="p">
        Each stage asks first, works through the ticked employees, and reports for each below. Merge takes only the Steward's PRs; Merge the team's PRs takes those the team opened as well (Team, in Settings).{offKitNote}
      </Text>
      <div className="row round">
        <Text variant="muted">{roundWords(v.round).when}</Text>
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
          <Badge tone="caution" label="Working" />{' '}
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
      <Section title="Staff" count={s?.rows.length}>
        {s ? <StaffTable s={s} /> : <Card className="empty">Looking at each employee…</Card>}
      </Section>
      <Section title="Roll out the kit">
        <Stages v={v} />
      </Section>
      <Section title="Last stage">
        <LastStage l={v.last} now={now} />
      </Section>
    </>
  );
}
