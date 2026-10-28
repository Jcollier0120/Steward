import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { openDialog } from './page-busy.ts';

/**
 * The page's own modals, never the browser's: a modal card (ModalCard), and the questions and messages a page asked
 * with confirm() and alert() before (confirmDialog, alertDialog), in the manor's look. Each one moves focus into
 * itself and keeps it there (Tab and Shift+Tab go round its buttons), Escape closes the top one only, and focus goes
 * back to where it was. page.ts's script draws the same dialog for a string-built page.
 *
 * One opened while the page waits on an action (page-busy.ts) is usable: a question the action asks, a sign-in it needs.
 */

/** What Tab can reach inside a modal, in order. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab (or Shift+Tab, `back`) goes from `at` among `stops`, so focus never leaves the modal: past the last back
 * to the first, before the first round to the last, and from outside them (the card itself) to the first or last.
 * Null where the browser's own Tab already lands inside.
 */
export function nextStop<T>(stops: readonly T[], at: T | null, back: boolean): T | null {
  if (!stops.length) return null;
  const i = at === null ? -1 : stops.indexOf(at);
  if (i < 0) return back ? stops[stops.length - 1] : stops[0];
  if (back && i === 0) return stops[stops.length - 1];
  if (!back && i === stops.length - 1) return stops[0];
  return null;
}

/** Keeps Tab inside `root`: what nextStop says, or the card itself when nothing in it takes focus. */
function trapTab(e: KeyboardEvent, root: HTMLElement) {
  const stops = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden], [inert]'));
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  const to = stops.length ? nextStop(stops, active, e.shiftKey) : root;
  if (!to) return;
  e.preventDefault();
  to.focus();
}

/** The modals open now, oldest first: only the last one hears Escape and Tab. */
const open: object[] = [];

/**
 * A card over a dimmed page: Escape or a click outside closes it (unless `dismissOnBackdrop` is false, for an editor an
 * accidental click mustn't discard). Focus moves into it (to the element marked data-autofocus, else the card) and
 * stays there, and goes back to where it was when it closes. `role` is alertdialog for a question that needs an
 * answer; `describedBy` names the element a screen reader reads as its text.
 */
export function ModalCard({ visible, onClose, children, maxHeightRatio = 0.8, className, dismissOnBackdrop = true, label, role = 'dialog', describedBy, modalClassName }: { visible: boolean; onClose: () => void; children: ReactNode; maxHeightRatio?: number; className?: string; dismissOnBackdrop?: boolean; label?: string; role?: 'dialog' | 'alertdialog'; describedBy?: string; modalClassName?: string }) {
  const card = useRef<HTMLDivElement>(null);
  // The latest onClose, so a page drawing it anew (an arrow each render) doesn't move focus about while it's open.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!visible) return;
    // First: a page waiting on the work that opened it lets it be answered (page-busy.ts), before focus moves into it.
    const shut = openDialog();
    const me = {};
    open.push(me);
    const before = document.activeElement as HTMLElement | null;
    const root = card.current;
    if (root && !root.contains(document.activeElement)) (root.querySelector<HTMLElement>('[data-autofocus]') ?? root).focus();
    const keys = (e: KeyboardEvent) => {
      if (open[open.length - 1] !== me || !card.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      } else if (e.key === 'Tab') trapTab(e, card.current);
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      open.splice(open.indexOf(me), 1);
      // Focus back first, while the page still lets it: a page that waits on again has it back when the work is done.
      if (before?.isConnected) before.focus?.();
      shut();
    };
  }, [visible]);
  if (!visible) return null;
  return (
    <div className={modalClassName ? `ui-modal ${modalClassName}` : 'ui-modal'} onClick={dismissOnBackdrop ? () => close.current() : undefined}>
      <div ref={card} className={className ? `ui-modal-card ${className}` : 'ui-modal-card'} role={role} aria-modal="true" aria-label={label} aria-describedby={describedBy} tabIndex={-1} style={{ maxHeight: `${Math.round(maxHeightRatio * 100)}vh` }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- confirm() and alert(), as the page's own dialogs

export interface DialogOptions {
  /** A heading over the text; none by default, as the browser's had none. */
  title?: string;
  /** The answering button's words: OK, as the browser's. */
  ok?: string;
  /** confirmDialog's other button: Cancel, as the browser's. */
  cancel?: string;
  /** OK in the danger colour, for a step that can't be undone. */
  danger?: boolean;
}

interface Asked extends Required<Omit<DialogOptions, 'title'>> {
  id: number;
  kind: 'confirm' | 'alert';
  text: string;
  title?: string;
  answer: (yes: boolean) => void;
}

let asked: Asked[] = [];
let lastId = 0;
const listeners = new Set<() => void>();
const changed = () => {
  for (const fn of listeners) fn();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const snapshot = () => asked;

/** A <dialog> opened with showModal(); a browser without :modal counts every open one. */
const isModal = (d: HTMLDialogElement) => {
  try {
    return d.matches(':modal');
  } catch {
    return true;
  }
};

/** Every DialogHost drawn now; with none, the first question draws one of its own. */
let hosts = 0;
let ownHost: HTMLElement | null = null;

/**
 * The host's place: in the top modal <dialog> when one is open (outside it, the page is inert and its buttons can't
 * be pressed), else at the end of the body.
 */
function placeHost() {
  if (typeof document === 'undefined') return;
  if (!ownHost) {
    if (hosts) return;
    ownHost = document.createElement('div');
    ownHost.dataset.kitDialogs = '';
    createRoot(ownHost).render(<DialogHost />);
  }
  const modal = [...document.querySelectorAll('dialog')].filter((d) => d.open && isModal(d)).pop();
  const into = modal ?? document.body;
  if (ownHost.parentElement !== into) into.append(ownHost);
}

function ask(kind: Asked['kind'], text: string, o: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const id = ++lastId;
    const answer = (yes: boolean) => {
      asked = asked.filter((a) => a.id !== id);
      changed();
      resolve(yes);
    };
    asked = [...asked, { id, kind, text, title: o.title, ok: o.ok ?? 'OK', cancel: o.cancel ?? 'Cancel', danger: !!o.danger, answer }];
    placeHost();
    changed();
  });
}

/** The page's own confirm(): `text` with OK and Cancel; true for OK, false for Cancel or Escape. */
export const confirmDialog = (text: string, o: DialogOptions = {}) => ask('confirm', text, o);

/** The page's own alert(): `text` with OK; done once it's closed (OK, or Escape). */
export const alertDialog = (text: string, o: Omit<DialogOptions, 'cancel'> = {}) => ask('alert', text, o).then(() => undefined);

/** The questions waiting for an answer, oldest first (for a test, or a page that shows it's waiting on one). */
export const dialogsOpen = (): readonly { kind: 'confirm' | 'alert'; text: string; answer: (yes: boolean) => void }[] => asked;

/**
 * Where the dialogs are drawn, one at a time, oldest first. The first question draws one by itself, so a page needs
 * none of its own; one a page draws (in a test, say) is used instead.
 */
export function DialogHost() {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    hosts++;
    return () => void hosts--;
  }, []);
  const d = all[0];
  return d ? <Dialog key={d.id} d={d} /> : null;
}

function Dialog({ d }: { d: Asked }) {
  const textId = useId();
  const confirm = d.kind === 'confirm';
  return (
    <ModalCard visible onClose={() => d.answer(!confirm)} dismissOnBackdrop={false} role="alertdialog" label={d.title ?? (confirm ? 'Question' : 'Message')} describedBy={textId} className="ui-dialog-card" modalClassName="ui-dialog">
      {d.title && (
        <h2 className="ui-dialog-title">
          {d.title}
        </h2>
      )}
      <p className="ui-dialog-text" id={textId}>
        {d.text}
      </p>
      <div className="ui-dialog-actions">
        <button type="button" className={d.danger ? 'ui-danger' : undefined} data-autofocus="" onClick={() => d.answer(true)}>
          {d.ok}
        </button>
        {confirm && (
          <button type="button" className="quiet" onClick={() => d.answer(false)}>
            {d.cancel}
          </button>
        )}
      </div>
    </ModalCard>
  );
}
