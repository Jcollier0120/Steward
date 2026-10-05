import { ago, badge, card, esc, muted, postButton, settingsPanel } from './kit/page.ts';
import { afterWords } from './after.ts';
import type { Alarm, AlarmState } from './alarms.ts';
import type { EmployeeResult, StageResult } from './stages/common.ts';
import type { PrInfo, Staff, StaffRow } from './stages/staff.ts';

/** The Steward's page body: the kit, the staff's table, the stages, the last stage, and Settings. */

const link = (url: string, text: string) => `<a href="${esc(url)}" rel="noreferrer">${esc(text)}</a>`;
/** A list of notes, each already HTML. */
const notesList = (items: string[]) => `<ul class="notes">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

function kitCell(r: StaffRow, kit: string | null): string {
  if (!r.usesKit) return badge('', 'not using the kit yet');
  const m = r.main;
  if (!m) return muted('unknown');
  if (m.oldKitFiles.length) return badge('alert', 'old kit', `Still tracks ${m.oldKitFiles.length} old kit files at their old paths: ${m.oldKitFiles.join(', ')}`);
  if (!m.kit) return badge('warn', 'no kit.json');
  return badge(m.kit === kit ? 'ok' : 'warn', `kit ${m.kit}`, m.parts ? `parts: ${m.parts.join(', ')}` : undefined);
}

function releaseCell(r: StaffRow): string {
  const rel = r.release;
  const parts: string[] = [];
  if (rel) {
    const kit = rel.kit === 'unknown' ? '' : rel.kit ? `, kit ${rel.kit}` : ', no kit';
    parts.push(`${link(`https://github.com/${r.repo}/releases/tag/${rel.tag}`, rel.tag)}${muted(kit)}`);
  } else parts.push(muted('none'));
  if (r.releaseNeeded && r.main?.version) parts.push(badge('warn', `${r.main.version} not released`));
  return parts.join('<br>');
}

/** The Steward's PRs and the team's: a team member's says whose, and what it is. */
function prCell(prs: PrInfo[], branch: string): string {
  if (!prs.length) return '';
  return prs
    .map((p) => {
      const checks = badge(p.checks === 'failing' ? 'alert' : p.checks === 'pending' ? 'warn' : 'ok', `checks ${p.checks}`);
      const merges = badge(p.mergeable === 'MERGEABLE' ? 'ok' : p.mergeable === 'CONFLICTING' ? 'alert' : 'warn', p.mergeable.toLowerCase());
      const into = p.base && p.base !== branch ? ` ${badge('warn', `into ${p.base}`, `Merge only takes a PR into ${branch}`)}` : '';
      const team = p.whose === 'team';
      const who = team ? ` ${badge('', 'team', `Opened by ${p.author}: merged by "Merge the team's PRs", or merge --team`)}` : '';
      const what = team ? `<br><span class="pr-title">${esc(p.title)}</span>` : '';
      // What it asks for once merged (its steward block), or why that can't be read.
      const then = p.afterError ? `<br>${badge('alert', 'steward block', p.afterError)}` : p.after ? `<br>${muted(`then: ${afterWords(p.after)}`)}` : '';
      return `<div class="pr">${link(p.url, `#${p.number}`)}${who} ${checks} ${merges}${p.draft ? ` ${badge('warn', 'draft')}` : ''}${into}${what}${then}<br>${muted(`${p.head}${team ? `, ${p.author}'s` : ''}`)}</div>`;
    })
    .join('');
}

function staffTable(s: Staff): string {
  const rows = s.rows
    .map((r) => {
      const co = r.checkout;
      const checkout = co.exists ? `<code>${esc(co.path)}</code><br>${muted(`${co.branch ?? ''}${co.changes ? `, ${co.changes} changed` : ''}`)}` : `${muted('no checkout at')} <code>${esc(co.path)}</code>`;
      const main = r.main ? `${esc(r.branch)} ${esc(r.main.version ?? '?')} ${muted(r.main.commit)}` : muted('unknown');
      const prepared = r.prepared ? `<code>${esc(r.prepared.branch)}</code><br>${muted(`${r.prepared.ahead} ahead, not pushed?`)}` : '';
      const notes = r.notes.filter((n) => n !== 'not using the kit yet');
      return `<tr>
<td><strong>${link(`https://github.com/${r.repo}`, r.name)}</strong><br>${muted(r.parts.join(', ') || 'no parts')}</td>
<td>${checkout}</td>
<td>${main}</td>
<td>${kitCell(r, s.kit)}</td>
<td>${releaseCell(r)}</td>
<td>${prCell(r.prs, r.branch)}${prepared}</td>
<td>${notes.length ? notesList(notes.map((n) => esc(n))) : ''}</td>
</tr>`;
    })
    .join('\n');
  return card(`<table>
<thead><tr><th>Employee</th><th>Checkout</th><th>Branch on origin</th><th>Kit</th><th>Latest release</th><th>Open PRs</th><th>Notes</th></tr></thead>
<tbody>
${rows}
</tbody></table>`);
}

const OUTCOME: Record<EmployeeResult['outcome'], string> = { done: 'ok', skipped: '', refused: 'warn', failed: 'alert' };

function lastStage(l: StageResult | null): string {
  if (!l) return card('No stage has run yet.', 'empty');
  const rows = l.results
    .map((r) => `<tr><td>${esc(r.name)}</td><td>${badge(OUTCOME[r.outcome], r.outcome)}</td><td>${esc(r.message)}${r.url ? ` ${link(r.url, 'link')}` : ''}</td></tr>`)
    .join('\n');
  const asked = Object.entries(l.asked)
    .filter(([, v]) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(',') : v}`)
    .join('; ');
  return card(`
<p><strong>${esc(l.stage)}</strong>${l.kit ? ` to kit ${esc(l.kit)}` : ''}, ${esc(ago(l.finished))}${asked ? ` ${muted(`(${asked})`)}` : ''}</p>
${l.error ? `<p>${badge('alert', 'stopped')} ${esc(l.error)}</p>` : ''}
${rows ? `<table><thead><tr><th>Employee</th><th>Result</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ''}
<details${l.error || l.results.some((r) => r.outcome === 'failed') ? ' open' : ''}><summary>Log (${l.log.length} lines)</summary><pre class="log">${esc(l.log.join('\n'))}</pre></details>
`);
}

/** Its rounds, as the page says them: merging and releasing by itself, or only when asked. (The title bar's pill says when the next is due.) */
export interface RoundView {
  on: boolean;
  minutes: number;
  onDuty: boolean;
  lastRunAt: string | null;
  /** Settings' rollout and releaseSelf. */
  rollout?: boolean;
  releaseSelf?: boolean;
}

function roundLine(r: RoundView | undefined, busy: boolean): string {
  if (!r) return '';
  const more = [r.releaseSelf ? 'releases its own new versions' : '', r.rollout ? 'rolls a new kit out to each employee behind it' : ''].filter(Boolean);
  const what = `merges every PR of its own and the team's that is ready, with what each asks for after, then releases each employee whose branch carries a version with no release, ${more.length ? `${more.join(', ')}, ` : ''}and approves the jobs whose installed scripts are the merged ones`;
  const when = !r.on
    ? 'It merges and releases only when asked: "Merges and releases by itself" is off in Settings. Run now does one round.'
    : `By itself, a round every ${r.minutes} minutes while on duty: it ${what}.${r.onDuty ? '' : ' Off duty, the rounds wait.'}${r.lastRunAt ? ` The last ended ${ago(r.lastRunAt)}.` : ''}`;
  // The kit lifts this into the title bar: the body's first button that POSTs /api/run and says Run now.
  return `<div class="row round">${muted(when)}${postButton('Run now', '/api/run', { quiet: true, confirm: `A round now: it ${what}?`, disabled: busy })}</div>`;
}

/** What needs the person (alarms.ts), at the top: each open one with its facts and a Dismiss; the dismissed and the lately cleared folded away. */
export function alarmsCard(a: AlarmState | undefined): string {
  if (!a) return '';
  const showing = a.open.filter((x) => !x.dismissedAt);
  const dismissed = a.open.filter((x) => x.dismissedAt);
  const item = (x: Alarm, i: number, button: boolean) => `<div class="alarm">
<div class="row alarm-head"><strong>${x.url ? link(x.url, x.title) : esc(x.title)}</strong>${button ? `<form id="alarm-${i}"><input type="hidden" name="id" value="${esc(x.id)}"></form>${postButton('Dismiss', '/api/alarms/dismiss', { quiet: true, form: `#alarm-${i}` })}` : ''}</div>
${x.detail.length ? notesList(x.detail.map((d) => esc(d))) : ''}
${muted(`Since ${ago(x.since)}${x.dismissedAt ? `, dismissed ${ago(x.dismissedAt)}` : ''}`)}</div>`;
  const folded = [
    dismissed.length ? `<details><summary class="muted">${dismissed.length} dismissed: back if they clear and return</summary>${dismissed.map((x, i) => item(x, i, false)).join('')}</details>` : '',
    a.cleared.length ? `<details><summary class="muted">Lately cleared</summary>${notesList(a.cleared.slice(0, 10).map((x) => `${esc(x.title)} ${muted(`(cleared ${ago(x.clearedAt)})`)}`))}</details>` : '',
  ].join('');
  if (!showing.length && !folded) return '';
  const head = showing.length ? `<h2>Needs you</h2>` : '';
  const body = showing.length ? showing.map((x) => item(x, a.open.indexOf(x), true)).join('') : muted('Nothing needs you.', 'p');
  return `<a id="alarms"></a>${head}${card(`${body}${folded}`, showing.length ? 'alarms' : '')}`;
}

export function renderBody(o: { staff: Staff | null; last: StageResult | null; running: { stage: string; since: string } | null; refreshing: boolean; team?: string[]; round?: RoundView; alarms?: AlarmState }): string {
  const s = o.staff;
  const kit = s?.kit ?? null;
  const kitLine = s
    ? `<p>The kit the Steward hands out: <strong>${esc(kit ?? 'none')}</strong>${s.released.length ? ` ${muted(`(released: ${s.released.slice(0, 5).join(', ')})`)}` : ''}${s.local ? ` ${muted(`· this checkout's kit\\VERSION: ${s.local}`)}` : ''}</p>${s.kitNote ? muted(s.kitNote, 'p') : ''}`
    : muted('Looking at the staff for the first time…', 'p');
  const running = o.running ? card(`${badge('warn', 'Working')} <span>${esc(o.running.stage)}, started ${esc(ago(o.running.since))}. This page refreshes itself until it's done.</span>`, 'row') : '';
  const onKit = s?.rows.filter((r) => r.usesKit) ?? [];
  const offKit = s?.rows.filter((r) => !r.usesKit) ?? [];
  // One that doesn't take the kit starts unticked: the stages pass over it, but the team's PRs to it can be merged.
  const boxes = (s?.rows ?? [])
    .map((r) => `<label class="pick"${r.usesKit ? '' : ` title="Doesn't take the kit yet: only the team's PRs are merged for it"`}><input type="checkbox" name="employees" value="${esc(r.id)}" data-keep${r.usesKit ? ' checked' : ''}> ${esc(r.name)}</label>`)
    .join(' ');
  const who = `the ticked employees (${onKit.length} take the kit)`;
  // Bump, Push and Release need a kit to hand out; nothing starts while a stage runs.
  const noKit = !!o.running || !kit;
  const stage = (n: string, path: string, confirm: string, disabled: boolean, title?: string) => postButton(n, `/api/stage/${path}`, { form: '#stage-form', confirm, disabled, title });
  const team = o.team ?? [];
  const teamAsk = `Merge the open PRs the team opened (${team.join(', ')}), and the Steward's, for the ticked employees: those that merge cleanly into the employee's branch and have no failing or running checks, with merge commits? Then each merged PR's steps from its steward block: release, install, and approving the jobs it names (merging counts as reading their scripts). The team's branches are left as they are.`;
  const offKitNote = offKit.length ? ` ${offKit.map((r) => r.name).join(' and ')} ${offKit.length === 1 ? "doesn't" : "don't"} take the kit yet: the stages pass over ${offKit.length === 1 ? 'it' : 'them'}, but the team's PRs to ${offKit.length === 1 ? 'it' : 'them'} can be merged.` : '';
  const stages = card(`
<form id="stage-form"><input type="hidden" name="kit" value="${esc(kit ?? '')}"><div class="picks">${boxes}</div></form>
<div class="row stages">
${stage('1. Bump', 'bump', `Bump ${who} to kit ${kit}? For each: a worktree of its branch, kit.json pinned to ${kit}, its patch version up, its kit filled and its checks run, then a commit. Nothing is pushed.`, noKit)}
${stage('2. Push', 'push', `Push the bumps to kit ${kit} and open their PRs? Nothing is force-pushed.`, noKit)}
${stage('3. Merge', 'merge', "Merge the Steward's PRs that merge cleanly and have no failing or running checks, with merge commits? Then any steps a merged PR's steward block asks for.", !!o.running)}
${stage('4. Release', 'release', `Release each ticked employee whose branch has kit ${kit} and an unreleased version, from that branch?`, noKit)}
${stage("Merge the team's PRs", 'merge-team', teamAsk, !!o.running || !team.length, team.length ? undefined : 'No team in Settings')}
${postButton(o.refreshing ? 'Refreshing…' : 'Refresh', '/api/staff/refresh', { quiet: true, disabled: !!o.running || o.refreshing })}
</div>
${muted(`Each stage asks first, works through the ticked employees, and reports for each below. Merge takes only the Steward's PRs; Merge the team's PRs takes those the team opened as well (Team, in Settings).${offKitNote}`, 'p')}
${roundLine(o.round, !!o.running)}
`);
  return `${running}${alarmsCard(o.alarms)}${card(`${kitLine}${s ? muted(`The table is from ${ago(s.at)}${s.checked && s.checked !== s.at ? `; GitHub had nothing new for it ${ago(s.checked)}` : ''}.`, 'p') : ''}`)}
<h2>Staff</h2>
${s ? staffTable(s) : card('Looking at each employee…', 'empty')}
<h2>Roll out the kit</h2>
${stages}
<h2>Last stage</h2>
${lastStage(o.last)}
<h2>Settings</h2>
${settingsPanel()}
<style>
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
</style>`;
}
