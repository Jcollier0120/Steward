import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { Spinner } from './icons.tsx';

/**
 * Busy, said on the page: a button whose work takes time spins while it runs and takes no presses (BusyButton, and
 * the kit's Button with `loading`), and the part of the page that work changes is disabled meanwhile (BusyArea).
 * Focus stays where it was: a control the browser lets go of as it's disabled has it back when the work is done.
 */

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** A BusyArea's word to what's in it: one more piece of work running in it, until the call it returns. */
const Area = createContext<(() => () => void) | null>(null);

const thenable = (x: unknown): x is PromiseLike<unknown> => !!x && typeof (x as { then?: unknown }).then === 'function';

/**
 * Work this component started and is waiting on: true until every promise `track` was given has settled, and its
 * BusyArea busy as long. A rejection is logged, as it would be unhandled; the work says its own errors.
 */
export function useTracked(): [boolean, (work: PromiseLike<unknown>) => void] {
  const [running, setRunning] = useState(0);
  const area = useContext(Area);
  const track = useCallback(
    (work: PromiseLike<unknown>) => {
      setRunning((n) => n + 1);
      const leave = area?.();
      const done = () => {
        setRunning((n) => n - 1);
        leave?.();
      };
      work.then(done, (e: unknown) => {
        console.error(e);
        done();
      });
    },
    [area],
  );
  return [running > 0, track];
}

/** No focus anywhere: what the browser leaves when the focused control is disabled under it. */
const focusLost = () => !document.activeElement || document.activeElement === document.body;

export type BusyButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  /** Busy for a reason of the page's own (the store says the work runs), as well as while its own press runs. */
  busy?: boolean;
  /** The leading glyph; the spinner takes its place while busy, and comes before the words when there's none. */
  icon?: ReactNode;
  /** What a press does: when it returns a promise, the button is busy until it settles. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => unknown;
  spinnerSize?: number;
};

/**
 * A button of the page's own look (its own classes) that says it's busy: a spinner, aria-busy and no presses while its
 * work runs, and its BusyArea disabled as long. Its focus comes back when the work is done.
 */
export function BusyButton({ busy = false, icon, onClick, disabled, children, type = 'button', spinnerSize = 14, ...rest }: BusyButtonProps) {
  const [pending, track] = useTracked();
  const spinning = busy || pending;
  const ref = useRef<HTMLButtonElement>(null);
  const hadFocus = useRef(false);
  useEffect(() => {
    if (spinning || !hadFocus.current) return;
    hadFocus.current = false;
    const el = ref.current;
    if (el && !el.disabled && focusLost()) el.focus();
  }, [spinning]);
  const press = onClick
    ? (e: MouseEvent<HTMLButtonElement>) => {
        hadFocus.current = document.activeElement === e.currentTarget;
        const r = onClick(e);
        if (thenable(r)) track(r);
      }
    : undefined;
  return (
    <button ref={ref} type={type} {...rest} disabled={disabled || spinning} aria-busy={spinning || undefined} onClick={press}>
      {spinning ? <Spinner size={spinnerSize} /> : icon}
      {children}
    </button>
  );
}

/**
 * A part of the page that is disabled while work that changes it runs: every control in it (a fieldset's own
 * disabled), aria-busy, and the busy cursor. Busy while `busy` says so, and while a BusyButton or PostButton in it
 * runs. It draws as a plain block, with no border or padding of its own.
 */
export function BusyArea({ busy = false, className, label, children }: { busy?: boolean; className?: string; label?: string; children: ReactNode }) {
  const [running, setRunning] = useState(0);
  const enter = useCallback(() => {
    setRunning((n) => n + 1);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      setRunning((n) => n - 1);
    };
  }, []);
  const on = busy || running > 0;
  const last = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = last.current;
    if (!on && el?.isConnected && !el.matches(':disabled') && focusLost()) el.focus();
  }, [on]);
  return (
    <Area.Provider value={enter}>
      <fieldset
        className={cx('ui-busy-area', className)}
        disabled={on}
        aria-busy={on || undefined}
        aria-label={label}
        onFocus={(e) => {
          if (e.target instanceof HTMLElement) last.current = e.target;
        }}
      >
        {children}
      </fieldset>
    </Area.Provider>
  );
}
