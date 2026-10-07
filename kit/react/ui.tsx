import { createContext, useContext, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, Spinner, type IconName } from './icons.tsx';
import { post } from './page-data.ts';

/**
 * The kit's core components: GamerNexus's mobile UI kit (apps/mobile/components/ui), its names, props, variants and
 * behaviour, drawn for a page in the manor's look (its themes, page.ts's classes, styles.ts). The user's call: keep
 * the API, not redesign it. Where GamerNexus's React Native prop has a web meaning it keeps its name (`onPress`,
 * `onChangeText`, `onValueChange`); `icon` takes the same Ionicons names (icons.tsx draws the ones the kit uses).
 *
 * Every agent wrote these out by hand before: `<span class="muted">` some 130 times across them, `<div class="card">`
 * some 95, a `badge` of its own in four (the Steward's `npm run ui:inventory` counts them).
 */

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export type TextVariant = 'title' | 'heading' | 'body' | 'muted' | 'label';
const TEXT: Record<TextVariant, string> = { title: 'ui-title', heading: 'ui-heading', body: '', muted: 'muted', label: 'ui-label' };

/** Text in one of the page's five styles. Inline by default; `as` makes it a paragraph, a heading or a block. */
export function Text({ variant = 'body', as = 'span', className, title, children }: { variant?: TextVariant; as?: 'span' | 'p' | 'div' | 'h2' | 'h3'; className?: string; title?: string; children: ReactNode }) {
  const Tag = as;
  return (
    <Tag className={cx(TEXT[variant], className) || undefined} title={title}>
      {children}
    </Tag>
  );
}

/** Enter and Space press a non-button element that acts as one (a pressable Card), as they press a button. */
const pressKeys = (onPress: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onPress();
  }
};

/**
 * A surface for grouped content. `onPress` makes the whole card a button; without it, it is exactly a card (as
 * GamerNexus's: two components, not one with a no-op handler). `tour` names it for the page's tour (shell.tsx).
 */
export function Card({ className, id, tour, onPress, children }: { className?: string; id?: string; tour?: string; onPress?: () => void; children: ReactNode }) {
  if (onPress)
    return (
      <div className={cx('card', 'ui-pressable', className)} id={id} data-tour={tour} role="button" tabIndex={0} onClick={onPress} onKeyDown={pressKeys(onPress)}>
        {children}
      </div>
    );
  return (
    <div className={cx('card', className)} id={id} data-tour={tour}>
      {children}
    </div>
  );
}

/** The rule between a card's body and its actions, at the one house spacing. `className` lays out what is below it. */
export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('ui-card-footer', className)}>{children}</div>;
}

/**
 * A titled block: a heading row (an icon or leading mark, the title, a "· 12" count, and `right` pinned to the far
 * end) with its content under it, at one of two spacings.
 */
export function Section({ title, icon, leading, count, right, gap = 'md', className, tour, children }: { title: string; icon?: IconName | ReactNode; leading?: ReactNode; count?: number; right?: ReactNode; gap?: 'md' | 'lg'; className?: string; tour?: string; children: ReactNode }) {
  return (
    <section className={cx('ui-section', `ui-gap-${gap}`, className)} data-tour={tour}>
      <div className="ui-section-head">
        <div className="ui-section-name">
          {leading}
          {icon !== undefined && <Icon name={icon} className="muted" />}
          <h2>{title}</h2>
          {count != null && <span className="muted ui-count">· {count}</span>}
        </div>
        {right && <div className="ui-section-right">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** An icon and a muted line of fact; `link` tints it, `fill` lets the text take the whole row. */
export function DetailRow({ icon, text, link = false, fill = false, className }: { icon?: IconName | ReactNode; text: ReactNode; link?: boolean; fill?: boolean; className?: string }) {
  return (
    <div className={cx('ui-detail-row', link && 'ui-link', className)}>
      {icon !== undefined && <Icon name={icon} size={15} />}
      <span className={cx('muted', fill ? 'ui-fill' : 'ui-shrink')}>{text}</span>
    </div>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-quiet';
export type ButtonSize = 'sm' | 'md' | 'lg';
/** On the manor's buttons (page.ts): primary is its filled button, secondary its quiet one, sm its small. */
const VARIANT: Record<ButtonVariant, string> = { primary: '', secondary: 'quiet', ghost: 'ui-ghost', danger: 'ui-danger', 'danger-quiet': 'quiet ui-danger-quiet' };
const SIZE: Record<ButtonSize, string> = { sm: 'small', md: '', lg: 'ui-lg' };

export interface ButtonProps {
  title: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A spinner in place of the icon, and no presses, while the work it started runs. */
  loading?: boolean;
  disabled?: boolean;
  /** Looks disabled and still takes presses: a gated action that explains itself when pressed. */
  disabledLook?: boolean;
  icon?: IconName;
  /** Any leading node; `icon` first. */
  leftIcon?: ReactNode;
  onPress?: () => void;
  /** The web's tooltip (GamerNexus's `title` is the label, so this is its own name). */
  tooltip?: string;
  /** A form's submit button rather than a plain one. */
  submit?: boolean;
  /** What a screen reader says, when the title alone isn't enough out of context ("Remove folder 2"). */
  accessibilityLabel?: string;
  /** Attributes a page's script or a test finds it by (data-post, data-tour). */
  data?: Record<`data-${string}`, string>;
}

/** The button: five weights (danger-quiet among other controls, danger only for the last step), three sizes. */
export function Button({ title, variant = 'primary', size = 'md', loading = false, disabled, disabledLook = false, icon, leftIcon, onPress, tooltip, submit, accessibilityLabel, data }: ButtonProps) {
  return (
    <button
      type={submit ? 'submit' : 'button'}
      className={cx(VARIANT[variant], SIZE[size], disabledLook && 'ui-dimmed') || undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-disabled={disabledLook || undefined}
      title={tooltip}
      aria-label={accessibilityLabel}
      onClick={onPress}
      {...data}
    >
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} /> : leftIcon}
      {title}
    </button>
  );
}

/** A glyph that is a button, with the same busy and disabled behaviour; its label is for screen readers. */
export function IconButton({ icon, onPress, accessibilityLabel, color, size = 18, loading = false, disabled = false, className }: { icon: IconName | ReactNode; onPress: () => void; accessibilityLabel: string; color?: string; size?: number; loading?: boolean; disabled?: boolean; className?: string }) {
  return (
    <button type="button" className={cx('icon-btn', color, className)} aria-label={accessibilityLabel} title={accessibilityLabel} disabled={loading || disabled} aria-busy={loading || undefined} onClick={onPress}>
      {loading ? <Spinner size={size} /> : <Icon name={icon} size={size} />}
    </button>
  );
}

/**
 * The badge's tones, GamerNexus's nine (its lib/tags.ts), on the manor's colours: success its ok, caution and premium
 * its warn, danger its alert, info its accent, subscription its NPU violet, host its gold, night a solid accent.
 */
export type BadgeTone = 'neutral' | 'info' | 'success' | 'premium' | 'caution' | 'danger' | 'night' | 'subscription' | 'host';

/** A small pill stating something about what it sits on. The manor's are always round, so `pill` changes nothing here. */
export function Badge({ label, tone = 'neutral', align = 'start', title }: { label: ReactNode; tone?: BadgeTone; align?: 'start' | 'end'; pill?: boolean; numberOfLines?: number; title?: string }) {
  return (
    <span className={cx('badge', `tone-${tone}`, align === 'end' && 'ui-end')} title={title}>
      {label}
    </span>
  );
}

/** A button that reads as a link: an action in a line of text (Reset to default, Skip the tour). The manor's own. */
export function LinkButton({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="link" disabled={disabled} onClick={onPress}>
      {title}
    </button>
  );
}

/** A list of notes in the quieter colour, one item each (the manor's own). */
export function Notes({ items }: { items: ReactNode[] }) {
  return (
    <ul className="notes">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

/** What a button calls once its POST is done: the page looks for news (usePageData's reload). */
const Reload = createContext<() => void | Promise<void>>(() => {});
export const ReloadProvider = Reload.Provider;

/**
 * A Button that POSTs to the agent's server with the page's token (the manor's own): `confirm` asks first (Cancel
 * sends nothing), `body` is what it sends (a function: worked out when pressed), an error or the server's `message` is
 * said, and the page then looks for news. It spins while it waits.
 */
export function PostButton({ path, body, confirm, ...button }: { path: string; body?: unknown | (() => unknown); confirm?: string } & Omit<ButtonProps, 'onPress' | 'loading' | 'submit'>) {
  const reload = useContext(Reload);
  const [waiting, setWaiting] = useState(false);
  const press = async () => {
    if (confirm && !window.confirm(confirm)) return;
    setWaiting(true);
    try {
      const r = await post(path, typeof body === 'function' ? (body as () => unknown)() : body);
      if (!r.ok) window.alert(r.json.error);
      else if (typeof r.json.message === 'string') window.alert(r.json.message);
      await reload();
    } finally {
      setWaiting(false);
    }
  };
  return <Button {...button} loading={waiting} onPress={() => void press()} data={{ 'data-post': path, ...button.data }} />;
}
