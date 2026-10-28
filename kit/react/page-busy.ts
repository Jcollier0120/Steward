/**
 * The page waiting on an action (kit 2.144.0): while the work a press started runs, every control on the page is
 * disabled (the Page's PageArea, busy.tsx: a fieldset's own disabled), the busy cursor and aria-busy say so, and the
 * pressed button spins. So nothing is pressed twice, nor pressed meanwhile on what the work is changing.
 *
 * What holds the page: a kit button's work (useTracked: Button's onPress, BusyButton's onClick and PostButton, while the
 * promise each returned runs), and a POST through the kit's post() that a press started (holdForPress), the new token's
 * retry and all. So a page's own <button onClick> that awaits post() holds it too, and the button pressed spins
 * (data-ui-busy: styles.ts draws its spinner). Polling never holds it (usePageData's looks are GETs of their own), nor
 * a post() no press started (one sent as someone types). An action that starts long work holds the page only until its
 * request answers: the work's progress is the page's own to show.
 *
 * Never for longer than pageWait's (PAGE_WAIT_MS): a request that doesn't answer lets the page go, its button still
 * spinning. A dialog the work opens while it runs (ModalCard, SidePanel, confirmDialog and alertDialog: openDialog) is
 * usable at once; one that was open before the work began waits with the page.
 */

/** The longest the page waits on one action: then it lets the person go on, while the action's button still spins. */
export const PAGE_WAIT_MS = 30_000;
let waitMs = PAGE_WAIT_MS;

/** How long the page waits on an action before it lets go (a test's short wait, or a page whose actions take longer); 0 is PAGE_WAIT_MS again. */
export function pageWait(ms: number) {
  waitMs = ms > 0 ? ms : PAGE_WAIT_MS;
}

/** Each hold and each open dialog, numbered in the order they began: a dialog opened after a hold doesn't wait on it. */
let numbered = 0;
const holds = new Set<number>();
const dialogs = new Set<number>();
const seen = new Set<() => void>();
const changed = () => {
  for (const fn of [...seen]) fn();
};

/** Whether the page waits now: a hold began after the newest dialog still open (with none open, any hold). */
export function pageHeld(): boolean {
  let top = 0;
  for (const d of dialogs) top = Math.max(top, d);
  for (const h of holds) if (h > top) return true;
  return false;
}

/** Calls `fn` each time pageHeld may have changed, until the call it returns. */
export function onPageHeld(fn: () => void): () => void {
  seen.add(fn);
  return () => void seen.delete(fn);
}

/** Holds the page until the call it returns, or pageWait's time, whichever comes first. */
export function holdPage(): () => void {
  const me = ++numbered;
  holds.add(me);
  changed();
  const late = setTimeout(go, waitMs);
  function go() {
    clearTimeout(late);
    if (holds.delete(me)) changed();
  }
  return go;
}

/** A dialog open until the call it returns: work that began before it doesn't hold it, so it can be answered. */
export function openDialog(): () => void {
  const me = ++numbered;
  dialogs.add(me);
  changed();
  return () => {
    if (dialogs.delete(me)) changed();
  };
}

// ---------------------------------------------------------------- presses

/** How long after a press a post() is still its work: a handler may ask first (confirmDialog), or read before it posts. */
export const PRESS_MS = 10_000;

/** What a person presses: a click on one is a press; a click anywhere else (a text field, the page itself) ends the last. */
const PRESSABLE =
  'button, summary, a[href], select, input:is([type="checkbox"], [type="radio"], [type="submit"], [type="button"], [type="image"], [type="reset"], [type="range"], [type="file"], [type="color"]), [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="option"], [role^="menuitem"]';

/**
 * The last press, and when; null once the person types, or clicks nothing pressable. Its time is when its event is done
 * with, so a handler that asks the browser's own confirm() first has as long as the person takes to answer it.
 */
let press: { el: Element; at: number } | null = null;
const pressed = (el: Element) => {
  const p = { el, at: performance.now() };
  press = p;
  setTimeout(() => (p.at = performance.now()));
};

/** Typing: the text fields' own input, after which a post() is no press's work (an auto-save, say). */
const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !t.matches(PRESSABLE)));

/** In a part of the page that waits now (PageArea's fieldset, disabled): a press there does nothing. */
const waiting = (t: EventTarget | null) => t instanceof Element && !!t.closest('fieldset.ui-page-area:disabled');

/**
 * The page's listeners, on the document before the page's own (capture): what was pressed, and no press at all on a part
 * of the page that waits. The fieldset disables its controls; this stops what it can't disable (links, pressable cards).
 */
function listen() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  document.addEventListener(
    'click',
    (e) => {
      if (waiting(e.target)) return stop(e);
      const el = e.target instanceof Element ? e.target.closest(PRESSABLE) : null;
      if (el) pressed(el);
      else press = null;
    },
    true,
  );
  for (const type of ['dblclick', 'auxclick'])
    document.addEventListener(
      type,
      (e) => {
        if (waiting(e.target)) stop(e);
      },
      true,
    );
  document.addEventListener(
    'keydown',
    (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && waiting(e.target)) stop(e);
    },
    true,
  );
  document.addEventListener(
    'submit',
    (e) => {
      if (e.target instanceof Element) pressed((e as SubmitEvent).submitter ?? e.target);
    },
    true,
  );
  document.addEventListener(
    'change',
    (e) => {
      if (e.target instanceof Element && e.target.matches(PRESSABLE)) pressed(e.target);
    },
    true,
  );
  document.addEventListener(
    'input',
    (e) => {
      if (typing(e.target)) press = null;
    },
    true,
  );
}
listen();

/** How many of the page's POSTs each button spins for: it stops when the last is done. */
const spinning = new WeakMap<Element, number>();

/** The spinner in a button (data-ui-busy; styles.ts draws it), until the call it returns. */
function spin(b: Element): () => void {
  spinning.set(b, (spinning.get(b) ?? 0) + 1);
  b.setAttribute('data-ui-busy', '');
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (spinning.get(b) ?? 1) - 1;
    if (n > 0) return void spinning.set(b, n);
    spinning.delete(b);
    b.removeAttribute('data-ui-busy');
  };
}

/**
 * The page held for a POST a press started (post()), and the button pressed spinning, until the call it returns: the
 * page for pageWait's time at most, the button until the POST is done. Nothing at all when no press started it. A press
 * whose button is gone (a dialog's OK) spins the one focus went back to, the button that opened the dialog.
 */
export function holdForPress(): () => void {
  const p = press;
  if (!p || performance.now() - p.at > PRESS_MS) return () => {};
  const letGo = holdPage();
  const at = p.el.isConnected ? p.el : document.activeElement;
  // A <button> spins; a switch, a box or a link waits with the page.
  const stopSpin = at instanceof HTMLButtonElement && at.isConnected ? spin(at) : null;
  return () => {
    letGo();
    stopSpin?.();
  };
}
