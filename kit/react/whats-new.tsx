import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * What's new, at the top of the About view (shell.tsx, kit 2.143.0): the agent's own changelog entries for the
 * versions its latest updates brought, newest first, each under its version (the node part's whats-new.ts chooses
 * them, and /api/whats-new gives them). With several, the newest is open and the older are folded. Only the newest 5
 * come (kit 2.146.7): when the updates brought older ones too, a line under them says how many aren't shown.
 *
 * An entry is drawn as text, never as HTML (spec/RELEASE-NOTES.md): its bold line, `### ` headings as small headings,
 * `- ` points as a list, `**bold**` and `` `code` ``, and a link as its words. Anything else is a plain paragraph.
 */

/** A version's entry, and when the agent first started at it (null: passed through on the way, or not known). */
export interface NewVersion {
  version: string;
  since: string | null;
  entry: string;
}

/** `**bold**` and `code` drawn as such, `[words](address)` as its words; the rest as it is. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/).map((part, i) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\([^)\s]+\)$/.exec(part);
    return link ? link[1] : part;
  });
}

/** One entry's text: paragraphs (lines run together until a blank one), headings, and lists of points. */
export function EntryText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let para: string[] = [];
  let points: string[] = [];
  const flush = () => {
    if (para.length) out.push(<p key={out.length}>{inline(para.join(' '))}</p>);
    if (points.length) out.push(<ul key={out.length}>{points.map((p, i) => <li key={i}>{inline(p)}</li>)}</ul>);
    para = [];
    points = [];
  };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const point = /^[-*] +(.*)$/.exec(line);
    if (point) {
      if (para.length) flush();
      points.push(point[1]);
    } else if (line && points.length && /^\s{2,}/.test(raw)) points[points.length - 1] += ` ${line}`;
    else if (!line) flush();
    else {
      const heading = /^#{2,6} +(.*)$/.exec(line);
      if (heading || points.length) flush();
      if (heading) out.push(<h4 key={out.length}>{inline(heading[1])}</h4>);
      else para.push(line);
    }
  }
  flush();
  return <>{out}</>;
}

/** The day the agent first started at a version, as this browser says dates ("27 October"; and the year, from another). */
function day(iso: string | null, now = Date.now()): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** A version's label: "Version 0.4.31", and the day it came when the agent started at it. */
function Label({ v }: { v: NewVersion }) {
  const when = day(v.since);
  return (
    <>
      <span className="release-version">Version {v.version}</span>
      {when && <span className="muted release-when"> · updated {when}</span>}
    </>
  );
}

/**
 * The section, for the versions given (none: nothing), and `older`, how many older versions the same updates brought
 * that aren't given: a line under the versions says so.
 */
export function WhatsNewList({ versions, name, older = 0 }: { versions: NewVersion[]; name: string; older?: number }) {
  if (!versions.length) return null;
  const several = versions.length > 1;
  return (
    <section className="whats-new" aria-labelledby="whats-new-title">
      <h3 id="whats-new-title">What's new</h3>
      {several && (
        <p className="muted whats-new-note">
          {older > 0 ? `The newest ${versions.length} versions that came with ${name}'s latest updates, newest first.` : `${versions.length} versions came with ${name}'s latest updates, newest first.`}
        </p>
      )}
      {several ? (
        versions.map((v, i) => (
          <details key={v.version} className="release-entry" open={i === 0}>
            <summary>
              <Label v={v} />
            </summary>
            <EntryText text={v.entry} />
          </details>
        ))
      ) : (
        <div className="release-entry">
          <p className="release-head">
            <Label v={versions[0]} />
          </p>
          <EntryText text={versions[0].entry} />
        </div>
      )}
      {older > 0 && (
        <p className="muted whats-new-note whats-new-older">
          {older === 1 ? "1 older version isn't shown here." : `${older} older versions aren't shown here.`}
        </p>
      )}
    </section>
  );
}

/** What /api/whats-new says, as the section takes it: only well-formed versions, none for anything else. */
export function versionsOf(json: unknown): NewVersion[] {
  const list = json && typeof json === 'object' ? (json as { versions?: unknown }).versions : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((x) =>
    x && typeof x.version === 'string' && typeof x.entry === 'string' && x.entry.trim() ? [{ version: x.version, since: typeof x.since === 'string' ? x.since : null, entry: x.entry }] : [],
  );
}

/** How many older versions /api/whats-new says it left out (kit 2.146.7): 0 for anything but a whole number above 0. */
export function olderOf(json: unknown): number {
  const n = json && typeof json === 'object' ? (json as { older?: unknown }).older : null;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The section as the About view has it: asked for the first time About opens (`open`), and kept. Until the answer, or
 * when there is none (an older page server, a failed look), nothing: About shows the rest as before.
 */
export function WhatsNew({ open, name }: { open: boolean; name: string }) {
  const [answer, setAnswer] = useState<{ versions: NewVersion[]; older: number } | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (!open || asked.current) return;
    asked.current = true;
    fetch('/api/whats-new', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setAnswer({ versions: versionsOf(json), older: olderOf(json) }))
      .catch(() => {
        // The page is restarting: About shows the rest, and opening it again asks again.
        asked.current = false;
      });
  }, [open]);
  return answer ? <WhatsNewList versions={answer.versions} name={name} older={answer.older} /> : null;
}
