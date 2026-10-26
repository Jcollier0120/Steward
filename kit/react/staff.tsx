import { useEffect, useState, type ReactNode } from 'react';
import { SHOW_TAB } from './tabs.tsx';
import { ago } from './time.ts';
import { Badge, Button } from './ui.tsx';

/**
 * The page of an agent that is an MCP server (Reeve, the Assayer, any staff an AI assistant calls): the parts Reeve's
 * page grew, for every such page to share, so they read alike. spec/STAFF-PAGE.md says the order and the rules.
 *
 * - `StaffLayout`: the order. What needs you (while anything does), at a glance, Connect your AI, Kept, then the
 *   agent's own sections.
 * - `NeedsYou`: what the person must look at or do, a card each, its edge the colour of its badge.
 * - `Glance`: a row of tiles, a number each, its colour the state; a tile goes to its section.
 * - `Row`: one line of a list (its badge, name, what matters, buttons), its details opening under it.
 * - `ConnectAI`: how to give an AI tool the agent's tools and the line for its instructions. Open until one is
 *   connected, then a single line that opens again to connect another.
 * - `Kept`: what the agent read so the AI didn't have to, as estimates: three totals and what each part read.
 * - `SidePanel` and `Output`: long output (a log, a failing test's output, a report) beside the page, never in it.
 * - `Paste`: text to copy. `useFold`: a fold this browser remembers.
 */

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** Whether a fold is open: as it was left (this browser remembers it, under `fold:<name>`), else `byDefault`. */
export function useFold(name: string, byDefault: boolean): [boolean, (open: boolean) => void] {
  const key = `fold:${name}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? byDefault : v === '1';
    } catch {
      return byDefault;
    }
  });
  const set = (o: boolean) => {
    setOpen(o);
    try {
      localStorage.setItem(key, o ? '1' : '0');
    } catch {
      // Storage blocked: it holds for this visit only.
    }
  };
  return [open, set];
}

/**
 * Scrolls to one of the page's sections by its tour name (the `tour` of a Section or Card). One in a page tab not
 * shown (PageTabs) has its tab chosen first, as the tour does, and is scrolled to once that tab is drawn.
 */
export function showSection(tour: string): void {
  const el = document.querySelector<HTMLElement>(`[data-tour="${tour.replace(/["\\]/g, '\\$&')}"]`);
  if (!el) return;
  const panel = el.closest<HTMLElement>('[role="tabpanel"][hidden]');
  if (!panel?.id.startsWith('page-panel-')) return el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.dispatchEvent(new CustomEvent(SHOW_TAB, { detail: panel.id.slice('page-panel-'.length) }));
  const scroll = (frames: number): unknown => (panel.hidden && frames ? requestAnimationFrame(() => scroll(frames - 1)) : el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  scroll(10);
}

/**
 * The page's order (spec/STAFF-PAGE.md): what needs you first while anything does, then at a glance, Connect your AI
 * and Kept, then the agent's own sections. `needsYou` is drawn only when `needs`; a page that keeps an empty Needs you
 * puts it among its own sections.
 */
export function StaffLayout({ needs = false, needsYou, glance, connect, kept, children }: { needs?: boolean; needsYou?: ReactNode; glance?: ReactNode; connect?: ReactNode; kept?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ui-staff">
      {needs && needsYou}
      {glance}
      {connect}
      {kept}
      {children}
    </div>
  );
}

export type GlanceTone = 'success' | 'caution' | 'danger' | 'neutral';

export interface GlanceTile {
  label: string;
  /** The number or the word that matters: "3", "9 of 11 OK", "Nothing". */
  value: ReactNode;
  /** One short line under it: what the number is made of, or that all is well. */
  note?: ReactNode;
  /** Its top edge: success, caution, danger; neutral (the default) is plain. */
  tone?: GlanceTone;
  /** The section it goes to, by its tour name. */
  to?: string;
  /** A button in the tile (Mark seen): the tile then goes nowhere itself. */
  action?: ReactNode;
}

/** The page at a glance, above its sections: a tile each for what is worth knowing first. */
export function Glance({ tiles, label = 'At a glance' }: { tiles: GlanceTile[]; label?: string }) {
  return (
    <div className="ui-glance" role="group" aria-label={label} data-tour="glance">
      {tiles.map((t) => {
        const className = cx('ui-tile', t.tone && t.tone !== 'neutral' && `ui-tile-${t.tone}`);
        const inside = (
          <>
            <span className="ui-tile-label">{t.label}</span>
            <span className="ui-tile-value">{t.value}</span>
            {t.note != null && t.note !== '' && <span className="ui-tile-note">{t.note}</span>}
            {t.action}
          </>
        );
        return t.to && !t.action ? (
          <button key={t.label} type="button" className={className} onClick={() => showSection(t.to!)}>
            {inside}
          </button>
        ) : (
          <div key={t.label} className={cx(className, 'ui-tile-static')}>
            {inside}
          </div>
        );
      })}
    </div>
  );
}

/** One thing that needs the person: its badge, what it is in a few words, a line more, and what to do about it. */
export interface Need {
  id: string;
  /** Its edge and badge: danger (something broke), caution (something to do). */
  tone: 'danger' | 'caution';
  /** The badge's words: "problem", "approval", "Settings". */
  label: string;
  title: ReactNode;
  text?: ReactNode;
  /** A button or two, at the row's end. */
  action?: ReactNode;
  /** Anything longer, under its row. */
  children?: ReactNode;
}

/**
 * Needs you: what the person must look at or do, a card each, at the top of the page (StaffLayout's `needsYou`, drawn
 * only while anything does). `empty` is said when nothing does, for a page that keeps the section among its own.
 * `children` go under the cards (or the empty line): quiet things that belong under the heading without being a need,
 * such as a queue with nothing waiting. Its heading is a `Section`'s, so it sits like every other section's.
 */
export function NeedsYou({ items, empty = 'Nothing needs you right now.', tour = 'needs-you', children }: { items: Need[]; empty?: ReactNode; tour?: string; children?: ReactNode }) {
  return (
    <section className="ui-section ui-gap-md ui-needs" data-tour={tour} aria-label="Needs you">
      <div className="ui-section-head">
        <div className="ui-section-name">
          <h2>Needs you</h2>
        </div>
      </div>
      {items.length ? (
        items.map((n) => (
          <div key={n.id} className={cx('card', 'ui-need', `ui-need-${n.tone}`)}>
            <div className="ui-line">
              <Badge tone={n.tone} label={n.label} />
              <strong>{n.title}</strong>
              {n.text && <span className="muted small">{n.text}</span>}
              {n.action && (
                <>
                  <span className="ui-fill" />
                  {n.action}
                </>
              )}
            </div>
            {n.children}
          </div>
        ))
      ) : (
        <p className="card muted">{empty}</p>
      )}
      {children}
    </section>
  );
}

/**
 * One row of a list, on one line: its badge, its name, a muted line of what matters (when, how long, where), and its
 * buttons at the end. With `more`, a Details button opens the rest under it; `open` opens it to start with.
 */
export function Row({ mark, title, meta, actions, more, open: byDefault = false, id }: { mark?: ReactNode; title: ReactNode; meta?: ReactNode; actions?: ReactNode; more?: ReactNode; open?: boolean; id?: string }) {
  const [open, setOpen] = useState(byDefault);
  return (
    <div className={cx('ui-list-row', open && 'ui-open')} id={id}>
      <div className="ui-line">
        {mark}
        <span className="ui-line-title">{title}</span>
        {meta && <span className="muted small ui-shrink">{meta}</span>}
        <span className="ui-fill" />
        {actions}
        {more != null && more !== false && (
          <button type="button" className="small quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Details'}
          </button>
        )}
      </div>
      {open && more != null && more !== false && <div className="ui-line-more">{more}</div>}
    </div>
  );
}

/** A block of text to paste somewhere, and Copy. */
export function Paste({ text, label }: { text: string; label?: string }) {
  const [said, setSaid] = useState('Copy');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setSaid('Copied');
    } catch {
      setSaid('Select it to copy');
    }
    setTimeout(() => setSaid('Copy'), 2000);
  };
  return (
    <div className="ui-paste">
      <pre aria-label={label}>{text}</pre>
      <Button title={said} variant="secondary" size="sm" onPress={() => void copy()} />
    </div>
  );
}

/** One AI tool's setup: its name, where the text goes, and the text (a command, or its MCP settings). */
export interface ClientSetup {
  id: string;
  name: string;
  where: ReactNode;
  text: string;
}

/** An AI tool that has connected: its name, and when it last used the agent's tools. */
export interface ConnectedClient {
  name: string;
  lastUsed?: string | null;
}

interface ConnectProps {
  /** The agent's name: "Reeve", "the Assayer". */
  agent: string;
  /** Whether an AI tool has the agent's tools now. */
  connected: boolean;
  /** The AI tools that connected, for the folded line ("Claude Code, last used 3 minutes ago"). */
  clients?: ConnectedClient[];
  /** The state in a line, in place of the clients' (Partly connected: …). */
  status?: ReactNode;
  /** What the agent gives an AI tool, in a sentence or two. The default says it is an MCP server. */
  about?: ReactNode;
  /** The agent's own one-press connect (Connect Claude Code), above the setups. */
  action?: ReactNode;
  /** Each AI tool's setup, as tabs. */
  setups: ClientSetup[];
  /** The line for the AI's own instructions, so it reaches for the tools unasked. */
  instruction?: string;
  tour?: string;
  /** Anything else the agent says here (Reeve's reminders in Claude Code). */
  children?: ReactNode;
}

/**
 * Connect your AI: the agent is an MCP server, and this says how to give an AI tool its tools (the exact setup for this
 * copy, per tool) and the line for the AI's instructions. Open until an AI tool is connected, then one line naming it,
 * which opens again to connect another. This browser remembers a fold.
 */
export function ConnectAI(p: ConnectProps) {
  // A fresh card when the first AI connects, so it folds on a page that was open at the time.
  return <ConnectCard key={p.connected ? 'connected' : 'not-yet'} {...p} />;
}

function ConnectCard({ agent, connected, clients = [], status, about, action, setups, instruction, tour = 'connect', children }: ConnectProps) {
  // Not connected yet: open until it's folded once. Connected: a line until it's opened. Each its own key, since the
  // open card's first render already saved "open" under the other.
  const [open, setOpen] = useFold(connected ? 'connect-open-connected' : 'connect-open', !connected);
  const [pick, setPick] = useState(setups[0]?.id);
  const setup = setups.find((x) => x.id === pick) ?? setups[0];
  const names = [...new Set(clients.map((c) => c.name))];
  const lastUse = clients.map((c) => c.lastUsed).filter((x): x is string => !!x).sort().pop() ?? null;
  const line = status ?? (connected && names.length ? `${names.join(', ')}, ${lastUse ? `last used ${ago(lastUse)}` : 'not used yet'}` : null);
  const Agent = agent.charAt(0).toUpperCase() + agent.slice(1);
  return (
    <details className={cx('card', 'ui-connect', !connected && 'ui-connect-todo')} data-tour={tour} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <strong>
          {connected ? (
            <>
              <span className="ui-ok">✓</span> Your AI is connected to {agent}
            </>
          ) : (
            `Connect your AI to ${agent}`
          )}
        </strong>
        {line && <span className="muted small"> {line}</span>}
        {connected && <span className="muted small"> · open it to connect another AI tool</span>}
      </summary>
      <p className="small">{about ?? `${Agent} is an MCP server: Claude Code, Codex, Cursor or any AI tool that speaks MCP can use its tools. Add it once; the tool starts it when it needs it.`}</p>
      {action && <div className="ui-connect-action">{action}</div>}
      {setup && (
        <>
          <div className="ui-connect-tools" role="tablist" aria-label="Your AI tool">
            {setups.map((x) => (
              <button key={x.id} type="button" role="tab" aria-selected={x.id === setup.id} className={cx('small', x.id !== setup.id && 'quiet')} onClick={() => setPick(x.id)}>
                {x.name}
              </button>
            ))}
          </div>
          <p className="small">{setup.where}</p>
          <Paste text={setup.text} label={`${setup.name} setup`} />
        </>
      )}
      {instruction && (
        <>
          <p className="small">
            <strong>Then tell your AI to use it.</strong> Put this in its instructions (CLAUDE.md for Claude Code, AGENTS.md for Codex, GEMINI.md, or Cursor's rules):
          </p>
          <Paste text={instruction} label="The line for its instructions" />
        </>
      )}
      {children}
    </details>
  );
}

/** One of Kept's totals: "This month (October)", "about 4.8M tokens", "about $14.46". */
export interface KeptStat {
  label: string;
  value: string;
  note?: string;
}

/** What one part read (a tool, a kind of work): its name, what it is, its tokens, and a note (its calls). */
export interface KeptRow {
  name: string;
  what?: string;
  value: string;
  note?: string;
}

/**
 * Kept: what the agent read on this PC so the AI assistant didn't have to, as estimates. Its totals (this month, last
 * month, all time), then what each part read; `empty` while nothing is counted. `footnote` says how it is counted.
 */
export function Kept({ title = 'Kept off the cloud', intro, stats, rows = [], counted, empty, footnote, tour = 'kept' }: { title?: string; intro?: ReactNode; stats: KeptStat[]; rows?: KeptRow[]; counted: boolean; empty?: ReactNode; footnote?: ReactNode; tour?: string }) {
  return (
    <section className="card ui-kept" data-tour={tour} aria-label={title}>
      <div className="ui-kept-head">
        <strong>{title}</strong>
        {intro && <span className="muted small">{intro}</span>}
      </div>
      <div className="ui-kept-stats">
        {stats.map((s) => (
          <div key={s.label} className="ui-kept-stat">
            <span className="ui-tile-label">{s.label}</span>
            <span className="ui-tile-value">{s.value}</span>
            {s.note && <span className="ui-tile-note">{s.note}</span>}
          </div>
        ))}
      </div>
      {counted && rows.length > 0 && (
        <ul className="ui-kept-rows small" aria-label="By part, all time">
          {rows.map((r) => (
            <li key={r.name}>
              <code>{r.name}</code>
              {r.what && <span className="muted"> {r.what}</span>}
              <span className="ui-fill" />
              <span>{r.value}</span>
              {r.note && <span className="muted"> {r.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {!counted && empty && <p className="muted small">{empty}</p>}
      {footnote && <p className="muted small">{footnote}</p>}
    </section>
  );
}

/** Long output as it was printed: monospace, wrapped, scrolling inside itself. */
export function Output({ text, label }: { text: string; label?: string }) {
  return (
    <pre className="ui-output" aria-label={label}>
      {text}
    </pre>
  );
}

/**
 * A panel beside the page for what is too long to stand in it: a log, a failing test's output, a report. Escape, Close
 * or a click outside it closes it. `meta` are lines under its title (where the file is, when it ran).
 */
export function SidePanel({ title, meta = [], onClose, children }: { title: ReactNode; meta?: ReactNode[]; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="ui-overlay" onClick={onClose}>
      <aside className="ui-side-panel" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'} onClick={(e) => e.stopPropagation()}>
        <div className="ui-side-head">
          <strong>{title}</strong>
          <Button title="Close" variant="secondary" size="sm" onPress={onClose} />
        </div>
        {meta.map((m, i) => (
          <p key={i} className="muted small">
            {m}
          </p>
        ))}
        {children}
      </aside>
    </div>
  );
}
