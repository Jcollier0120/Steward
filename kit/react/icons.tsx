import type { ReactNode } from 'react';

/**
 * The glyphs the kit's components draw, by the Ionicons names GamerNexus's components take (`icon="refresh"`), so a
 * component reads the same in both. A page has no icon font: these are drawn here, 16 × 16 in the text's colour, as
 * the title bar's are. A name not here draws nothing; a component that takes an icon also takes any node.
 */
export type IconName =
  | 'refresh'
  | 'checkmark'
  | 'checkmark-circle'
  | 'close'
  | 'close-circle'
  | 'alert-circle'
  | 'information-circle'
  | 'chevron-forward'
  | 'chevron-down'
  | 'time'
  | 'add'
  | 'trash'
  | 'open'
  | 'settings';

const PATHS: Record<IconName, ReactNode> = {
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" />,
  checkmark: <path d="M3 8.5 6.5 12 13 4.5" />,
  'checkmark-circle': (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.3 8.2 1.9 1.9 3.6-3.9" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  'close-circle': (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
    </>
  ),
  'alert-circle': (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.8v3.6M8 10.9v.1" />
    </>
  ),
  'information-circle': (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.4v3.8M8 5v.1" />
    </>
  ),
  'chevron-forward': <path d="M6 3.5 10.5 8 6 12.5" />,
  'chevron-down': <path d="M3.5 6 8 10.5 12.5 6" />,
  time: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.3 1.5" />
    </>
  ),
  add: <path d="M8 3.5v9M3.5 8h9" />,
  trash: <path d="M3 4.5h10M6.3 4.5V3h3.4v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />,
  open: <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13H3V4.5h3.5" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </>
  ),
};

/** A glyph by name, or the node given, as it is. */
export function Icon({ name, size = 16, className }: { name: IconName | ReactNode; size?: number; className?: string }) {
  if (typeof name !== 'string') return <>{name}</>;
  const paths = PATHS[name as IconName];
  if (!paths) return null;
  return (
    <svg className={className ? `ui-icon ${className}` : 'ui-icon'} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {paths}
    </svg>
  );
}

/** The busy mark: a small turning ring in the text's colour, the size of a glyph. */
export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return <span className="ui-spinner" style={{ width: size, height: size }} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
