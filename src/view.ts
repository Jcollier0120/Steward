import { ago, esc, settingsPanel } from './kit/page.ts';
import type { EmployeeResult, StageResult } from './stages/common.ts';
import type { PrInfo, Staff, StaffRow } from './stages/staff.ts';

/** The Steward's page body: the kit, the staff's table, the stages, the last stage, and Settings. */

const badge = (cls: string, text: string, title?: string) => `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
const link = (url: string, text: string) => `<a href="${esc(url)}" rel="noreferrer">${esc(text)}</a>`;

function kitCell(r: StaffRow, kit: string | null): string {
  if (!r.usesKit) return badge('', 'not using the kit yet');
  const m = r.main;
  if (!m) return '<span class="muted">unknown</span>';
  if (m.oldKitFiles.length) return badge('alert', 'old kit', `Still tracks ${m.oldKitFiles.length} old kit files at their old paths: ${m.oldKitFiles.join(', ')}`);
  if (!m.kit) return badge('warn', 'no kit.json');
  return badge(m.kit === kit ? 'ok' : 'warn', `kit ${m.kit}`, m.parts ? `parts: ${m.parts.join(', ')}` : undefined);
}

function releaseCell(r: StaffRow): string {
  const rel = r.release;
  const parts: string[] = [];
  if (rel) {
    const kit = rel.kit === 'unknown' ? '' : rel.kit ? `, kit ${rel.kit}` : ', no kit';
    parts.push(`${link(`https://github.com/${r.repo}/releases/tag/${rel.tag}`, rel.tag)}<span class="muted">${esc(kit)}</span>`);
  } else parts.push('<span class="muted">none</span>');
  if (r.releaseNeeded && r.main?.version) parts.push(badge('warn', `${r.main.version} not released`));
  return parts.join('<br>');
}

function prCell(prs: PrInfo[]): string {
  if (!prs.length) return '';
  return prs
    .map((p) => {
      const checks = badge(p.checks === 'failing' ? 'alert' : p.checks === 'pending' ? 'warn' : 'ok', `checks ${p.checks}`);
      const merges = badge(p.mergeable === 'MERGEABLE' ? 'ok' : p.mergeable === 'CONFLICTING' ? 'alert' : 'warn', p.mergeable.toLowerCase());
      return `<div>${link(p.url, `#${p.number}`)} ${checks} ${merges}${p.draft ? ` ${badge('warn', 'draft')}` : ''}<br><span class="muted">${esc(p.head)}</span></div>`;
    })
    .join('');
}

function staffTable(s: Staff): string {
  const rows = s.rows
    .map((r) => {
      const co = r.checkout;
      const checkout = co.exists ? `<code>${esc(co.path)}</code><br><span class="muted">${esc(co.branch ?? '')}${co.changes ? `, ${co.changes} changed` : ''}</span>` : `<span class="muted">no checkout at</span> <code>${esc(co.path)}</code>`;
      const main = r.main ? `${esc(r.branch)} ${esc(r.main.version ?? '?')} <span class="muted">${esc(r.main.commit)}</span>` : '<span class="muted">unknown</span>';
      const prepared = r.prepared ? `<code>${esc(r.prepared.branch)}</code><br><span class="muted">${r.prepared.ahead} ahead, not pushed?</span>` : '';
      const notes = r.notes.filter((n) => n !== 'not using the kit yet');
      return `<tr>
<td><strong>${link(`https://github.com/${r.repo}`, r.name)}</strong><br><span class="muted">${esc(r.parts.join(', ') || 'no parts')}</span></td>
<td>${checkout}</td>
<td>${main}</td>
<td>${kitCell(r, s.kit)}</td>
<td>${releaseCell(r)}</td>
<td>${prCell(r.prs)}${prepared}</td>
<td>${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</td>
</tr>`;
    })
    .join('\n');
  return `<div class="card"><table>
<thead><tr><th>Employee</th><th>Checkout</th><th>Branch on origin</th><th>Kit</th><th>Latest release</th><th>Steward PRs</th><th>Notes</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`;
}

const OUTCOME: Record<EmployeeResult['outcome'], string> = { done: 'ok', skipped: '', refused: 'warn', failed: 'alert' };

function lastStage(l: StageResult | null): string {
  if (!l) return '<div class="card empty">No stage has run yet.</div>';
  const rows = l.results
    .map((r) => `<tr><td>${esc(r.name)}</td><td>${badge(OUTCOME[r.outcome], r.outcome)}</td><td>${esc(r.message)}${r.url ? ` ${link(r.url, 'link')}` : ''}</td></tr>`)
    .join('\n');
  const asked = Object.entries(l.asked)
    .filter(([, v]) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(',') : v}`)
    .join('; ');
  return `<div class="card">
<p><strong>${esc(l.stage)}</strong>${l.kit ? ` to kit ${esc(l.kit)}` : ''}, ${esc(ago(l.finished))}${asked ? ` <span class="muted">(${esc(asked)})</span>` : ''}</p>
${l.error ? `<p>${badge('alert', 'stopped')} ${esc(l.error)}</p>` : ''}
${rows ? `<table><thead><tr><th>Employee</th><th>Result</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ''}
<details${l.error || l.results.some((r) => r.outcome === 'failed') ? ' open' : ''}><summary>Log (${l.log.length} lines)</summary><pre class="log">${esc(l.log.join('\n'))}</pre></details>
</div>`;
}

export function renderBody(o: { staff: Staff | null; last: StageResult | null; running: { stage: string; since: string } | null; refreshing: boolean }): string {
  const s = o.staff;
  const kit = s?.kit ?? null;
  const kitLine = s
    ? `<p>The kit the Steward hands out: <strong>${esc(kit ?? 'none')}</strong>${s.released.length ? ` <span class="muted">(released: ${esc(s.released.slice(0, 5).join(', '))})</span>` : ''}${s.local ? ` <span class="muted">· this checkout's kit\\VERSION: ${esc(s.local)}</span>` : ''}</p>${s.kitNote ? `<p class="muted">${esc(s.kitNote)}</p>` : ''}`
    : '<p class="muted">Looking at the staff for the first time…</p>';
  const running = o.running ? `<div class="card row">${badge('warn', 'Working')} <span>${esc(o.running.stage)}, started ${esc(ago(o.running.since))}. This page refreshes itself until it's done.</span></div>` : '';
  const onKit = s?.rows.filter((r) => r.usesKit) ?? [];
  const boxes = (s?.rows ?? [])
    .map((r) => `<label class="pick"><input type="checkbox" name="employees" value="${esc(r.id)}" data-keep${r.usesKit ? ' checked' : ' disabled'}> ${esc(r.name)}</label>`)
    .join(' ');
  const who = `the ticked employees (${onKit.length} take the kit)`;
  const disabled = o.running || !kit ? ' disabled' : '';
  const stages = `<div class="card">
<form id="stage-form"><input type="hidden" name="kit" value="${esc(kit ?? '')}"><div class="picks">${boxes}</div></form>
<div class="row stages">
<button data-post="/api/stage/bump" data-form="#stage-form" data-confirm="${esc(`Bump ${who} to kit ${kit}? For each: a worktree of its branch, kit.json pinned to ${kit}, its patch version up, its kit filled and its checks run, then a commit. Nothing is pushed.`)}"${disabled}>1. Bump</button>
<button data-post="/api/stage/push" data-form="#stage-form" data-confirm="${esc(`Push the bumps to kit ${kit} and open their PRs? Nothing is force-pushed.`)}"${disabled}>2. Push</button>
<button data-post="/api/stage/merge" data-form="#stage-form" data-confirm="Merge the Steward's PRs that merge cleanly and have no failing or running checks, with merge commits?"${o.running ? ' disabled' : ''}>3. Merge</button>
<button data-post="/api/stage/release" data-form="#stage-form" data-confirm="${esc(`Release each ticked employee whose branch has kit ${kit} and an unreleased version, from that branch?`)}"${disabled}>4. Release</button>
<button class="quiet" data-post="/api/staff/refresh"${o.running || o.refreshing ? ' disabled' : ''}>${o.refreshing ? 'Refreshing…' : 'Refresh'}</button>
</div>
<p class="muted">Each stage asks first, works through the ticked employees, and reports for each below. Reeve and Heiward are listed, but don't take the kit yet.</p>
</div>`;
  return `${running}<div class="card">${kitLine}${s ? `<p class="muted">The table is from ${esc(ago(s.at))}.</p>` : ''}</div>
<h2>Staff</h2>
${s ? staffTable(s) : '<div class="card empty">Looking at each employee…</div>'}
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
pre.log { max-height: 420px; overflow: auto; font: 12px/1.45 "Cascadia Mono", Consolas, monospace; white-space: pre-wrap; background: var(--bg); padding: 8px; border-radius: 6px; }
td a { color: var(--accent); }
</style>`;
}
