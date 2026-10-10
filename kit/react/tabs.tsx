import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/**
 * A row of tabs (WAI-ARIA tabs: the arrows, Home and End move between them, and the chosen one is the only one in the
 * tab order). The page keeps which is chosen; each tab's panel is `<prefix>-panel-<id>`, labelled by its tab
 * `<prefix>-tab-<id>`. Settings' tabs (Page's `settingsTabs`) are drawn with it, and an agent's page may use it too.
 */
export function Tabs<T extends string>({ tabs, tab, onChoose, label, prefix = 'tabs' }: { tabs: readonly { id: T; label: string }[]; tab: T; onChoose: (id: T) => void; label: string; prefix?: string }) {
  const row = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const to = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onChoose(tabs[to].id);
    row.current?.querySelector<HTMLButtonElement>(`#${prefix}-tab-${tabs[to].id}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={row} onKeyDown={move}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" className="tab" id={`${prefix}-tab-${t.id}`} aria-selected={t.id === tab} aria-controls={`${prefix}-panel-${t.id}`} tabIndex={t.id === tab ? 0 : -1} onClick={() => onChoose(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** One tab of an agent's Settings (Page's `settingsTabs`): its address is #/settings/<id>. */
export interface SettingsTab {
  /** Letters, digits and dashes: it's part of the address. "general" is the kit's own (the Settings form). */
  id: string;
  label: string;
  content: ReactNode;
}

/** The Settings tab the address names (#/settings/<id>), or null at plain #/settings. */
export const settingsTabInHash = (hash: string): string | null => /^#\/?settings\/([\w-]+)$/.exec(hash)?.[1] ?? null;

/**
 * Which of Settings' tabs is chosen, kept in the address (#/settings/<id>, so a reload or a link keeps it): the one it
 * names when there is such a tab, else the first. Choosing one replaces the address, so Back still leaves Settings.
 */
export function useSettingsTab(ids: readonly string[]): [string, (id: string) => void] {
  const pick = () => {
    const want = settingsTabInHash(location.hash);
    return want && ids.includes(want) ? want : ids[0];
  };
  const [tab, setTab] = useState(pick);
  useEffect(() => {
    const change = () => setTab(pick());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, [ids.join(' ')]);
  const choose = (id: string) => {
    setTab(id);
    history.replaceState(null, '', `#/settings/${id}`);
  };
  return [ids.includes(tab) ? tab : ids[0], choose];
}
