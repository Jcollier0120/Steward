import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ErrorNote } from './feedback.tsx';
import { Switch } from './forms.tsx';
import { post } from './page-data.ts';
import { APPLIES_NOTE, blank, canon, clone, laterNotes, same, SCALAR, shown, shownNow, tidy, words, type Messages, type SettingsData, type SettingsField } from './settings-values.ts';
import { Badge, Button, LinkButton, Text } from './ui.tsx';

/**
 * The Settings form, in React: what web/settings-panel.js draws, field for field and class for class (its stylesheet,
 * web/settings-panel.css, styles both), from GET /api/settings, saving with POST /api/settings the changed values
 * only. Each field shows its default with Reset to default, a "changed" mark until it's saved, and each message from
 * the server beside the field it is about. The server checks everything and is the authority.
 *
 * `keys` limits it to those settings, in that order: onboarding's settings step (tour.tsx) shows the few a new hire
 * needs. Every field kind the schema has is drawn: switch, whole, number, text, choice, choices, list, records,
 * group and map.
 */

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ') || undefined;

/** The server's messages by path, an error winning over a warning at the same path. */
type Msgs = Record<string, { kind: 'error' | 'warning'; text: string }>;
function toMsgs(errors: Messages = {}, warnings: Messages = {}): Msgs {
  const out: Msgs = {};
  for (const [p, text] of Object.entries(errors)) out[p] = { kind: 'error', text };
  for (const [p, text] of Object.entries(warnings)) if (!out[p]) out[p] = { kind: 'warning', text };
  return out;
}
const MsgContext = createContext<Msgs>({});
/** The form's top-level values now, which a field's `shownWhen` reads, wherever the field is. */
const TopContext = createContext<Obj>({});

/** The fields of a list that show now: by `shownWhen`, and any with a message, which shows it anyway. */
function useShown(fields: SettingsField[], path: (f: SettingsField) => string): SettingsField[] {
  const top = useContext(TopContext);
  const msgs = useContext(MsgContext);
  return fields.filter((f) => shownNow(f, top) || under(msgs, path(f)));
}

/** Seldom-changed fields, folded after the rest; a message about one of them unfolds it. */
function Advanced({ count, open, children }: { count: number; open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  if (!count) return null;
  return (
    <details className="sf-advanced" open={opened || open} onToggle={(e) => setOpened(e.currentTarget.open)}>
      <summary>Advanced ({count})</summary>
      {children}
    </details>
  );
}
const msgId = (path: string) => `sfm-${path}`;
/** A message at this path, or under it (a field of a folded record). */
const under = (msgs: Msgs, path: string) => Object.keys(msgs).some((p) => p === path || p.startsWith(`${path}.`));

function Msg({ path }: { path: string }) {
  const m = useContext(MsgContext)[path];
  return m ? (
    <p className={`sf-msg ${m.kind}`} id={msgId(path)} aria-live="polite">
      {m.text}
    </p>
  ) : null;
}
const useInvalid = (path: string) => useContext(MsgContext)[path]?.kind === 'error' || undefined;

interface EdProps {
  f: SettingsField;
  value: unknown;
  onChange: (v: unknown) => void;
  path: string;
}

/** A number as it is typed ("0." on its way to "0.5" stays as typed), and as the server reads it. */
const parseNumber = (t: string, f: SettingsField): unknown => (t.trim() === '' ? (f.nullable ? null : '') : Number.isFinite(Number(t)) ? Number(t) : t);

function NumberInput({ f, value, onChange, path, id, aria }: EdProps & { id?: string; aria?: string }) {
  const [text, setText] = useState(value === undefined || value === null ? '' : String(value));
  // Following a change from outside (Reset, Cancel, a save), not the field's own typing.
  useEffect(() => {
    if (JSON.stringify(parseNumber(text, f)) !== JSON.stringify(value ?? (f.nullable ? null : ''))) setText(value === undefined || value === null ? '' : String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = f.kind === 'whole' || f.kind === 'number' ? f : null;
  return (
    <input type="number" id={id} min={n?.min} max={n?.max} step={f.kind === 'whole' ? 1 : 'any'} inputMode={f.kind === 'whole' ? 'numeric' : 'decimal'} value={text} aria-label={aria} aria-invalid={useInvalid(path)} aria-describedby={msgId(path)} onChange={(e) => (setText(e.target.value), onChange(parseNumber(e.target.value, f)))} />
  );
}

/** One control on one line: a switch, a number, a text, a choice; or the value, for a setting shown and never changed. */
function Scalar({ f, value, onChange, path, id, aria }: EdProps & { id?: string; aria?: string }) {
  const invalid = useInvalid(path);
  if (f.readOnly) return <Text variant="muted">{shown(value)}</Text>;
  if (f.kind === 'switch') return <Switch id={id} value={value === true} onValueChange={onChange} accessibilityLabel={aria} />;
  if (f.kind === 'whole' || f.kind === 'number') return <NumberInput f={f} value={value} onChange={onChange} path={path} id={id} aria={aria} />;
  if (f.kind === 'choice')
    return (
      <select id={id} value={String(value ?? '')} aria-label={aria} aria-invalid={invalid} aria-describedby={msgId(path)} onChange={(e) => onChange(e.target.value)}>
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  const t = f.kind === 'text' ? f : null;
  return <input type="text" id={id} spellCheck={false} autoComplete="off" maxLength={t?.maxLength ?? (t?.path ? 1000 : 500)} placeholder={t?.placeholder} value={String(value ?? '')} aria-label={aria} aria-invalid={invalid} aria-describedby={msgId(path)} onChange={(e) => onChange(e.target.value)} />;
}

function Choices({ f, value, onChange }: EdProps) {
  const picked = Array.isArray(value) ? value : [];
  if (f.kind !== 'choices') return null;
  return (
    <div className="sf-choices">
      {f.options.map((o) => (
        <label key={o.value}>
          <input type="checkbox" checked={picked.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...picked, o.value] : picked.filter((x) => x !== o.value))} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** A setting that may be null ("Automatic"): ticked, its editor goes, and comes back as it was when unticked. */
function NullBox({ f, value, onChange, children }: EdProps & { children: ReactNode }) {
  const last = useRef<unknown>(value === null ? (f.kind === 'list' ? [] : f.kind === 'group' ? Object.fromEntries(f.fields.map((g) => [g.key, blank(g)])) : '') : value);
  if (value !== null) last.current = value;
  return (
    <>
      <SwitchLabel control={<Switch value={value === null} onValueChange={(on) => onChange(on ? null : last.current)} />} label={f.nullable} />
      {value !== null && children}
    </>
  );
}

function List({ f, value, onChange, path }: EdProps) {
  const [added, setAdded] = useState(-1);
  if (f.kind !== 'list') return null;
  const items = Array.isArray(value) ? value.map((x) => String(x ?? '')) : [];
  const noun = f.item.label.toLowerCase();
  return (
    <div>
      <ul className="sf-list">
        {items.map((x, i) => (
          <li key={i}>
            <div className="sf-item">
              <ListItem f={f} value={x} path={`${path}.${i}`} label={`${f.item.label} ${i + 1}`} focus={i === added} onChange={(s) => onChange(items.map((y, j) => (j === i ? s : y)))} />
              <Button title="Remove" variant="secondary" size="sm" accessibilityLabel={`Remove ${noun} ${i + 1}`} onPress={() => onChange(items.filter((_, j) => j !== i))} />
            </div>
            <Msg path={`${path}.${i}`} />
          </li>
        ))}
      </ul>
      <Button title={`Add ${noun}`} variant="secondary" size="sm" disabled={f.maxItems !== undefined && items.length >= f.maxItems} onPress={() => (setAdded(items.length), onChange([...items, '']))} />
    </div>
  );
}

function ListItem({ f, value, path, label, focus, onChange }: { f: SettingsField & { kind: 'list' }; value: string; path: string; label: string; focus: boolean; onChange: (s: string) => void }) {
  return <input type="text" spellCheck={false} autoComplete="off" autoFocus={focus} maxLength={f.item.maxLength ?? (f.item.path ? 1000 : 500)} placeholder={f.item.placeholder} value={value} aria-label={label} aria-invalid={useInvalid(path)} aria-describedby={msgId(path)} onChange={(e) => onChange(e.target.value)} />;
}

/** The most fields a record shows as a table row; a wider record folds to a line (RecordBox). */
const TABLE_FIELDS = 4;

/** A table of rows the form edits: its column headings, and an empty one over each row's Remove. */
function EditTable({ headings, children }: { headings: string[]; children: ReactNode }) {
  return (
    <div className="sf-scroll">
      <table className="sf-table">
        <thead>
          <tr>
            {headings.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Text by text, an object whose keys a person chooses: rows kept as typed, two empty keys and all. */
function MapEd({ f, value, onChange, path }: EdProps) {
  const toRows = (v: unknown) => Object.entries(asObj(v)).map(([k, x]) => [k, String(x ?? '')] as [string, string]);
  const [rows, setRows] = useState(() => toRows(value));
  useEffect(() => {
    if (JSON.stringify(Object.fromEntries(rows)) !== JSON.stringify(asObj(value))) setRows(toRows(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  if (f.kind !== 'map') return null;
  const put = (next: [string, string][]) => (setRows(next), onChange(Object.fromEntries(next)));
  const cell = (i: number, which: 0 | 1, label: string) => (
    <td data-label={label}>
      <input type="text" spellCheck={false} autoComplete="off" value={rows[i][which]} aria-label={`${label} ${i + 1}`} onChange={(e) => put(rows.map((r, j) => (j === i ? (which ? [r[0], e.target.value] : [e.target.value, r[1]]) : r)))} />
      <Msg path={which ? `${path}.${i}.value` : `${path}.${i}`} />
    </td>
  );
  return (
    <div>
      <EditTable headings={[f.keyLabel, f.valueLabel]}>
        {rows.map((_, i) => (
          <tr key={i}>
            {cell(i, 0, f.keyLabel)}
            {cell(i, 1, f.valueLabel)}
            <td>
              <Button title="Remove" variant="secondary" size="sm" accessibilityLabel={`Remove ${f.keyLabel.toLowerCase()} ${i + 1}`} onPress={() => put(rows.filter((__, j) => j !== i))} />
            </td>
          </tr>
        ))}
      </EditTable>
      <Button title={`Add ${f.keyLabel.toLowerCase()}`} variant="secondary" size="sm" disabled={f.maxItems !== undefined && rows.length >= f.maxItems} onPress={() => put([...rows, ['', '']])} />
    </div>
  );
}

function Records({ f, value, onChange, path }: EdProps) {
  const [added, setAdded] = useState(-1);
  if (f.kind !== 'records') return null;
  const recs = Array.isArray(value) ? value.map(asObj) : [];
  const noun = (f.noun || 'entry').toLowerCase();
  // A table row only while it reads as one: a few plain fields, none advanced. Anything more folds to a line of its own.
  // A record's handle (kept) goes with it, never drawn.
  const drawn = f.fields.filter((g) => !g.kept);
  const flat = drawn.length <= TABLE_FIELDS && drawn.every((g) => SCALAR.includes(g.kind) && !g.advanced && !g.shownWhen);
  const set = (i: number, r: Obj) => onChange(recs.map((x, j) => (j === i ? r : x)));
  const remove = (i: number) => (
    <Button title="Remove" variant="secondary" size="sm" accessibilityLabel={`Remove ${noun} ${i + 1}`} onPress={() => onChange(recs.filter((_, j) => j !== i))} />
  );
  const add = <Button title={`Add ${noun}`} variant="secondary" size="sm" disabled={f.maxItems !== undefined && recs.length >= f.maxItems} onPress={() => (setAdded(recs.length), onChange([...recs, clone(f.blank) ?? Object.fromEntries(f.fields.map((g) => [g.key, blank(g)]))]))} />;
  if (flat)
    return (
      <div>
        <EditTable headings={drawn.map((g) => g.label)}>
          {recs.map((r, i) => (
            <tr key={i}>
              {drawn.map((g) => (
                <td key={g.key} data-label={g.label}>
                  <Scalar f={g} value={r[g.key]} path={`${path}.${i}.${g.key}`} aria={`${g.label}, ${noun} ${i + 1}`} onChange={(v) => set(i, { ...r, [g.key]: v })} />
                  <Msg path={`${path}.${i}.${g.key}`} />
                </td>
              ))}
              <td>
                {remove(i)}
                <Msg path={`${path}.${i}`} />
              </td>
            </tr>
          ))}
        </EditTable>
        {add}
      </div>
    );
  return (
    <div>
      {recs.map((r, i) => (
        <RecordBox key={i} f={f} r={r} i={i} path={`${path}.${i}`} isNew={i === added} noun={noun} onChange={(x) => set(i, x)} remove={remove(i)} />
      ))}
      {add}
    </div>
  );
}

/**
 * A record folded to one line, its title (which follows its title field as it's typed), opened by a click: one with a
 * list or a group in it, or more fields than a table row holds well. Its advanced fields fold inside it.
 */
function RecordBox({ f, r, i, path, isNew, noun, onChange, remove }: { f: SettingsField & { kind: 'records' }; r: Obj; i: number; path: string; isNew: boolean; noun: string; onChange: (r: Obj) => void; remove: ReactNode }) {
  const [open, setOpen] = useState(isNew);
  const msgs = useContext(MsgContext);
  const shown = useShown(f.fields, (g) => `${path}.${g.key}`);
  const title = f.title && r[f.title] ? String(r[f.title]) : `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${i + 1}`;
  const block = (g: SettingsField) => <FieldBlock key={g.key} f={g} value={r[g.key]} path={`${path}.${g.key}`} onChange={(v) => onChange({ ...r, [g.key]: v })} />;
  const advanced = shown.filter((g) => g.advanced);
  return (
    <details className="sf-record" open={open || under(msgs, path)} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{title}</summary>
      <div role="group" aria-label={title}>
        {shown.filter((g) => !g.advanced).map(block)}
        <Advanced count={advanced.length} open={advanced.some((g) => under(msgs, `${path}.${g.key}`))}>
          {advanced.map(block)}
        </Advanced>
      </div>
      <div className="row">{remove}</div>
      <Msg path={path} />
    </details>
  );
}

/** A few settings kept together, each a field of its own, with its own default; its advanced ones folded after. */
function Group({ f, value, onChange, path, def, saved }: EdProps & { def?: unknown; saved?: unknown }) {
  const msgs = useContext(MsgContext);
  const shown = useShown(f.kind === 'group' ? f.fields : [], (g) => `${path}.${g.key}`);
  if (f.kind !== 'group') return null;
  const obj = asObj(value);
  const block = (g: SettingsField) => (
    <FieldBlock key={g.key} f={g} value={obj[g.key]} path={`${path}.${g.key}`} def={def === undefined || def === null ? undefined : asObj(def)[g.key]} saved={saved === undefined ? undefined : asObj(saved)[g.key]} tracked={saved !== undefined} onChange={(v) => onChange({ ...obj, [g.key]: v })} />
  );
  const advanced = shown.filter((g) => g.advanced);
  return (
    <div>
      {shown.filter((g) => !g.advanced).map(block)}
      <Advanced count={advanced.length} open={advanced.some((g) => under(msgs, `${path}.${g.key}`))}>
        {advanced.map(block)}
      </Advanced>
    </div>
  );
}

function Editor(p: EdProps & { def?: unknown; saved?: unknown }) {
  const ed =
    p.f.kind === 'choices' ? <Choices {...p} />
    : p.f.kind === 'list' ? <List {...p} />
    : p.f.kind === 'records' ? <Records {...p} />
    : p.f.kind === 'map' ? <MapEd {...p} />
    : <Group {...p} />;
  return p.f.nullable && (p.f.kind === 'list' || p.f.kind === 'group') ? <NullBox {...p}>{ed}</NullBox> : ed;
}

/** A switch with its words beside it, the words its label. */
const SwitchLabel = ({ control, label }: { control: ReactNode; label: ReactNode }) => (
  <label className="sf-switch">
    {control}
    <span>{label}</span>
  </label>
);

/** Under a field: what empty means, its default and Reset to default, and whether it waits for the next start. */
function FieldMeta({ f, value, def, top, onChange }: { f: SettingsField; value: unknown; def?: unknown; top: boolean; onChange: (v: unknown) => void }) {
  const meta: ReactNode[] = [];
  if (f.kind === 'text' && (f.nullable || f.empty)) meta.push(<span key="empty">Empty: {f.nullable || f.empty}.</span>);
  if (def !== undefined && f.kind !== 'group' && !f.readOnly) {
    meta.push(<span key="default">Default: {words(f, def)}.</span>);
    meta.push(<LinkButton key="reset" title="Reset to default" disabled={same(f, value, def)} onPress={() => onChange(clone(def))} />);
  }
  if (top && f.applies && f.applies !== 'now') meta.push(<Badge key="applies" tone="caution" label={APPLIES_NOTE[f.applies]} />);
  return meta.length ? <p className="sf-meta">{meta}</p> : null;
}

/**
 * One setting: its label, control, help, default with Reset to default, "changed" until saved, and its message.
 * `def` shows the default (settings and a group's fields; a record's fields don't), `tracked` marks it changed, and
 * `fold` makes a top-level group a section of its own, folded unless the form says it's open.
 */
function FieldBlock({ f, value, onChange, path, def, saved, tracked = false, top = false, fold }: EdProps & { def?: unknown; saved?: unknown; tracked?: boolean; top?: boolean; fold?: { open: boolean; onToggle: (open: boolean) => void } }) {
  const id = useId();
  const cls = cx('sf', !!fold && 'sf-section', tracked && !same(f, value, saved) && 'is-changed');
  const help = f.help ? (
    <p className="sf-help" id={`${id}-help`}>
      {f.help}
    </p>
  ) : null;
  const tail = (
    <>
      <FieldMeta f={f} value={value} def={def} top={top} onChange={onChange} />
      <Msg path={path} />
    </>
  );
  const mark = <span className="badge tone-subscription sf-changed">changed</span>;
  if (SCALAR.includes(f.kind)) {
    const scalar = <Scalar f={f} value={value} onChange={onChange} path={path} id={id} />;
    const switchLabel = f.kind === 'switch' && !f.readOnly;
    return (
      <div className={cls} data-key={f.key}>
        <div className="sf-head">
          {switchLabel ? <SwitchLabel control={scalar} label={f.label} /> : f.readOnly ? <span className="sf-name">{f.label}</span> : <label htmlFor={id}>{f.label}</label>}
          {mark}
        </div>
        {!switchLabel && (
          <div className="sf-control">
            {scalar}
            {(f.kind === 'whole' || f.kind === 'number') && f.unit && <Text variant="muted">{f.unit}</Text>}
          </div>
        )}
        {help}
        {tail}
      </div>
    );
  }
  const body = (
    <>
      {help}
      <Editor f={f} value={value} onChange={onChange} path={path} def={def} saved={saved} />
      {tail}
    </>
  );
  if (fold)
    return (
      <details className={cls} data-key={f.key} id={sectionId(f.key)} open={fold.open} onToggle={(e) => fold.onToggle(e.currentTarget.open)}>
        <summary>
          <span>{f.label}</span> {mark}
        </summary>
        {body}
      </details>
    );
  return (
    <div className={cls} data-key={f.key}>
      <fieldset className={f.kind === 'group' ? 'sf-group' : 'sf-plain'} aria-describedby={cx(f.help && `${id}-help`, msgId(path))}>
        <legend>
          <span>{f.label}</span> {mark}
        </legend>
        {body}
      </fieldset>
    </div>
  );
}

const sectionId = (key: string) => `sf-section-${key}`;

/** The form's panel holding only a line: loading, couldn't load, nothing to set. */
const PanelNote = ({ children }: { children: ReactNode }) => (
  <div className="card sf-panel" data-tour="settings-panel">
    {children}
  </div>
);

/**
 * The settings' state: GET /api/settings's answer (or `initial`, in hand), the values being edited, the ones saved, the
 * server's messages, and the status line; `save` POSTs the changed values of `fields`, tidied first.
 */
function useSettings(initial: SettingsData | undefined, onSaved?: () => void) {
  const [data, setData] = useState<SettingsData | null>(initial ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  const [draft, setDraft] = useState<Obj>(() => clone(initial?.values ?? {}));
  const [saved, setSaved] = useState<Obj>(() => clone(initial?.values ?? {}));
  const [msgs, setMsgs] = useState<Msgs>(() => toMsgs({}, initial?.warnings));
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: '' });
  const [busy, setBusy] = useState(false);
  const fresh = (d: SettingsData, values: Obj, warnings: Messages = d.warnings) => {
    setData({ ...d, values });
    setSaved(clone(values));
    setDraft(clone(values));
    setMsgs(toMsgs({}, warnings));
  };
  const load = async () => {
    setFailed(null);
    try {
      const r = await fetch('/api/settings', { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const d = (await r.json()) as SettingsData;
      fresh(d, d.values);
    } catch (e) {
      setFailed((e as Error).message);
    }
  };
  useEffect(() => {
    if (!initial) void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (fields: SettingsField[]) => {
    if (!data) return;
    const tidied: Obj = { ...draft };
    for (const f of fields) if (!f.readOnly) tidied[f.key] = tidy(f, draft[f.key]);
    setDraft(tidied);
    const values: Obj = {};
    for (const f of fields) if (!f.readOnly && !same(f, tidied[f.key], saved[f.key])) values[f.key] = canon(f, tidied[f.key]);
    if (!Object.keys(values).length) return setStatus({ text: 'Nothing to save.' });
    setBusy(true);
    setStatus({ text: 'Saving…' });
    try {
      const r = await post('/api/settings', { values });
      if (!r.ok) {
        setMsgs(toMsgs(r.json.errors as Messages, {}));
        return setStatus({ text: r.json.error ?? 'Not saved.', error: true });
      }
      fresh(data, r.json.values as Obj, r.json.warnings as Messages);
      setStatus({ text: [r.json.message ?? 'Saved.', ...((r.json.notes as string[]) ?? [])].join(' ') });
      onSaved?.();
    } catch (e) {
      setStatus({ text: `Not saved: ${(e as Error).message}.`, error: true });
    } finally {
      setBusy(false);
    }
  };
  return { data, failed, load, draft, setDraft, saved, msgs, setMsgs, status, setStatus, busy, save };
}

/**
 * Above the fields: where they're saved and when they're used, what's wrong with the file, and the form's own message.
 * The file's path and its problems' own words are a developer's: the server sends them only while the manor's
 * Developer options are on (settings-kit.ts), and an empty `file` says they're off.
 */
function FormHead({ data, later, general }: { data: SettingsData; later: string[]; general?: Msgs[string] }) {
  const usedFrom = data.usedFrom || 'from the next round on';
  const dev = !!data.file;
  return (
    <>
      <p className="sf-intro muted">
        Changes are checked and saved here{dev && <>, into <code>{data.file}</code></>}
        {later.length ? `. They are used ${usedFrom}, except those marked ${later.map((n) => `"${n}"`).join(' or ')}.` : `. They are used ${usedFrom}.`}
      </p>
      <div className="sf-problems">
        {data.problems.map((p, i) => (
          <p key={i} className="sf-msg warning">
            <Badge tone="caution" label={dev ? 'settings.json' : 'Settings'} /> {p}
          </p>
        ))}
      </div>
      {general && (
        <p className={`sf-msg sf-general ${general.kind}`} role="alert" tabIndex={-1}>
          {general.text}
        </p>
      )}
    </>
  );
}

/** The bar that stays in view below the fields: Save, Cancel, what happened, and Set every field to its default. */
function FormActions({ dirty, busy, status, onCancel, onDefaults }: { dirty: boolean; busy: boolean; status: { text: string; error?: boolean }; onCancel: () => void; onDefaults: () => void }) {
  return (
    <div className="sf-actions">
      <Button title="Save" submit disabled={!dirty || busy} loading={busy} />
      <Button title="Cancel" variant="secondary" disabled={!dirty || busy} onPress={onCancel} />
      <p className={`sf-status ${status.error ? 'error' : 'muted'}`} role="status" aria-live="polite">
        {status.text}
      </p>
      <span className="sf-spacer" />
      <LinkButton title="Set every field to its default" onPress={onDefaults} />
    </div>
  );
}

/** A warning before leaving with changes not saved, and focus on the first field the server refused. */
function useFormGuards(root: RefObject<HTMLDivElement | null>, dirty: boolean, msgs: Msgs, refused: boolean | undefined, onDirty?: (dirty: boolean) => void) {
  useEffect(() => onDirty?.(dirty), [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) return;
    const stay = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', stay);
    return () => window.removeEventListener('beforeunload', stay);
  }, [dirty]);
  useEffect(() => {
    if (refused) root.current?.querySelector<HTMLElement>('[aria-invalid="true"], .sf-general')?.focus();
  }, [msgs, refused, root]);
}

/**
 * The agent's settings, as a form: all of them, or `keys` (onboarding's few, never an advanced one). A short page: the
 * ordinary settings, each top-level group a section of its own (folded unless it's the only one, with jump links when
 * there are two or more), and the advanced ones folded under Advanced at the end. A field with `shownWhen` shows only
 * while its key holds one of those values. `initial` is GET /api/settings's answer, already in hand (a test's).
 */
export function SettingsForm({ keys, onSaved, onDirty, initial }: { keys?: string[]; onSaved?: () => void; onDirty?: (dirty: boolean) => void; initial?: SettingsData }) {
  const s = useSettings(initial, onSaved);
  const { data, draft, saved, msgs } = s;
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const root = useRef<HTMLDivElement>(null);
  const fields = data ? (keys ? keys.map((k) => data.schema.find((f) => f.key === k)).filter((f): f is SettingsField => !!f && !f.advanced) : data.schema) : [];
  const dirty = fields.some((f) => !f.readOnly && !same(f, draft[f.key], saved[f.key]));
  useFormGuards(root, dirty, msgs, s.status.error, onDirty);
  if (s.failed)
    return (
      <PanelNote>
        <ErrorNote message={`The settings couldn't be loaded: ${s.failed}.`} onRetry={() => void s.load()} />
      </PanelNote>
    );
  const note = (text: string) => (
    <PanelNote>
      <Text variant="muted" as="p">
        {text}
      </Text>
    </PanelNote>
  );
  if (!data) return note('Loading the settings…');
  // A developer's whole form, with Developer options off: none of it, not even an empty form.
  if (data.developerOnly) return null;
  const visible = fields.filter((f) => shownNow(f, draft) || under(msgs, f.key));
  if (keys && !visible.length) return note('Nothing to set: the defaults just work.');
  const ordinary = visible.filter((f) => !f.advanced);
  const advanced = visible.filter((f) => f.advanced);
  const sections: SettingsField[] = keys ? [] : ordinary.filter((f) => f.kind === 'group');
  const open = (key: string) => sections.length === 1 || !!opened[key] || under(msgs, key);
  const jump = (key: string) => {
    setOpened({ ...opened, [key]: true });
    requestAnimationFrame(() => document.getElementById(sectionId(key))?.scrollIntoView({ block: 'start' }));
  };
  const block = (f: SettingsField) => (
    <FieldBlock key={f.key} f={f} value={draft[f.key]} path={f.key} def={data.defaults[f.key]} saved={saved[f.key]} tracked top onChange={(v) => s.setDraft({ ...draft, [f.key]: v })} fold={sections.includes(f) ? { open: open(f.key), onToggle: (o) => setOpened({ ...opened, [f.key]: o }) } : undefined} />
  );
  const cancel = () => {
    s.setDraft(clone(saved));
    s.setMsgs(toMsgs({}, data.warnings));
    s.setStatus({ text: 'Changes undone.' });
  };
  const defaults = () => {
    s.setDraft({ ...draft, ...Object.fromEntries(fields.filter((f) => !f.readOnly).map((f) => [f.key, clone(data.defaults[f.key])])) });
    s.setStatus({ text: 'Every field shows its default now. Save to keep them, or Cancel.' });
  };
  return (
    <div ref={root} className="card sf-panel" data-tour="settings-panel" data-dirty={dirty ? '' : undefined}>
      <TopContext.Provider value={draft}>
        <MsgContext.Provider value={msgs}>
          {sections.length >= 2 && (
            <nav className="sf-jump" aria-label="Sections">
              {sections.map((f) => (
                <LinkButton key={f.key} title={f.label} onPress={() => jump(f.key)} />
              ))}
            </nav>
          )}
          <FormHead data={data} later={laterNotes(fields)} general={msgs['']} />
          <form className="sf-form" noValidate onSubmit={(e) => (e.preventDefault(), void s.save(fields))}>
            {ordinary.map(block)}
            <Advanced count={advanced.length} open={advanced.some((f) => under(msgs, f.key))}>
              {advanced.map(block)}
            </Advanced>
            <FormActions dirty={dirty} busy={s.busy} status={s.status} onCancel={cancel} onDefaults={defaults} />
          </form>
        </MsgContext.Provider>
      </TopContext.Provider>
    </div>
  );
}
