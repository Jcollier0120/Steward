import { useId, type ReactNode } from 'react';
import { Icon, Spinner, type IconName } from './icons.tsx';

/**
 * The kit's form controls, on GamerNexus's API (apps/mobile/components/ui), for a page in the manor's look: the
 * pieces the schema-driven Settings form and onboarding's settings step are built from.
 */

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** A text field with its label, an error under it, and a clear (×) button or a busy spinner inside it. */
export function Input({ label, error, clearable, busy, value, onChangeText, placeholder, type = 'text', disabled, className, id }: { label?: string; error?: string; clearable?: boolean; busy?: boolean; value: string; onChangeText: (text: string) => void; placeholder?: string; type?: 'text' | 'number' | 'search' | 'url' | 'password'; disabled?: boolean; className?: string; id?: string }) {
  const own = useId();
  const fieldId = id ?? own;
  const showClear = clearable && !!value && !disabled;
  return (
    <div className="ui-input">
      {label && (
        <label className="ui-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <div className={cx('ui-field', error && 'ui-error')}>
        <input id={fieldId} type={type} className={className} value={value} placeholder={placeholder} disabled={disabled} aria-invalid={error ? true : undefined} onChange={(e) => onChangeText(e.target.value)} />
        {(busy || showClear) && (
          <span className="ui-field-tools">
            {busy && <Spinner size={14} />}
            {showClear && (
              <button type="button" className="icon-btn" aria-label="Clear text" onClick={() => onChangeText('')}>
                <Icon name="close-circle" />
              </button>
            )}
          </span>
        )}
      </div>
      {error && <span className="ui-error-text">{error}</span>}
    </div>
  );
}

/** One choice in a Select; `value` is unique within the options. */
export interface SelectOption<T> {
  label: string;
  value: T;
  hint?: string;
}

/** A single choice from a list: the browser's own list on a page (GamerNexus opens a bottom sheet on a phone). */
export function Select<T extends string | number>({ label, placeholder = 'Select…', value, options, onChange, error, disabled }: { label?: string; placeholder?: string; value: T | null | undefined; options: SelectOption<T>[]; onChange: (value: T) => void; error?: string; disabled?: boolean }) {
  const id = useId();
  const at = options.findIndex((o) => o.value === value);
  return (
    <div className="ui-input">
      {label && (
        <label className="ui-label" htmlFor={id}>
          {label}
        </label>
      )}
      <div className={cx('ui-field', error && 'ui-error')}>
        <select id={id} value={at < 0 ? '' : String(at)} disabled={disabled} aria-invalid={error ? true : undefined} onChange={(e) => onChange(options[Number(e.target.value)].value)}>
          {at < 0 && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((o, i) => (
            <option key={String(o.value)} value={String(i)} title={o.hint}>
              {o.hint ? `${o.label} (${o.hint})` : o.label}
            </option>
          ))}
        </select>
      </div>
      {error && <span className="ui-error-text">{error}</span>}
    </div>
  );
}

/** An on/off switch: a checkbox with the switch role, drawn as a track and a thumb in the theme's colours. */
export function Switch({ value, onValueChange, disabled, accessibilityLabel, id }: { value: boolean; onValueChange: (value: boolean) => void; disabled?: boolean; accessibilityLabel?: string; id?: string }) {
  return <input type="checkbox" role="switch" className="ui-switch" id={id} checked={value} disabled={disabled} aria-label={accessibilityLabel} onChange={(e) => onValueChange(e.target.checked)} />;
}

export type ChoiceValue = string | number | boolean;
export type ChoiceLayout = 'row' | 'wrap' | 'stack';
export interface ChoiceOption<T extends ChoiceValue> {
  value: T;
  label: string;
  icon?: IconName;
  /** Pinned to the far end of a `stack` option: a Badge. */
  right?: ReactNode;
  /** Greyed and unpressable, still shown: hiding it would say it doesn't exist. */
  disabled?: boolean;
  accessibilityLabel?: string;
}

/** Bordered options in a row, a wrapping row or a stack, the picked one filled; `children` sit among them. */
export function ChoiceGroup<T extends ChoiceValue>({ options, value, onChange, layout = 'row', size = 'md', className, children }: { options: ChoiceOption<T>[]; value: T; onChange: (value: T) => void; layout?: ChoiceLayout; size?: 'md' | 'sm'; className?: string; children?: ReactNode }) {
  return (
    <div className={cx('ui-choices', `ui-${layout}`, size === 'sm' && 'ui-sm', className)} role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} aria-label={o.accessibilityLabel} disabled={o.disabled} className={cx('ui-choice', o.value === value && 'ui-on')} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} />}
          <span className="ui-fill">{o.label}</span>
          {layout === 'stack' && o.right}
        </button>
      ))}
      {children}
    </div>
  );
}

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  icon?: IconName;
}

/** A segmented switch: equal options in one row, the active one filled. The standard control for tabs and either/or. */
export function Segmented<T extends string | number>({ options, value, onChange, className }: { options: SegmentedOption<T>[]; value: T; onChange: (value: T) => void; className?: string }) {
  return (
    <div className={cx('ui-segmented', className)} role="tablist">
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? 'ui-on' : undefined} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The receipt of an auto-saving field: "Saving…" while it saves, "Saved" for a moment after; nothing at rest. */
export function SaveStatus({ pending, saved }: { pending: boolean; saved: boolean }) {
  if (pending)
    return (
      <span className="ui-save muted" role="status">
        <Spinner size={12} /> Saving…
      </span>
    );
  if (saved)
    return (
      <span className="ui-save ui-saved" role="status">
        <Icon name="checkmark-circle" size={14} /> Saved
      </span>
    );
  return null;
}
