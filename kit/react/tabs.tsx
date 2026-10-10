import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/**
 * A row of tabs (WAI-ARIA tabs: the arrows, Home and End move between them, and the chosen one is the only one in the
 * tab order). The page keeps which is chosen; each tab's panel is `<prefix>-panel-<id>`, labelled by its tab
 * `<prefix>-tab-<id>`. Settings' tabs (Page's `settingsTabs`) are drawn with it, and an agent's page may use it too.
 */
export function Tabs<T extends string>({ tabs, tab, onChoose, label, prefix = 'tabs' }: { tabs: readonly { id: T; label: string; count?: number; mark?: string }[]; tab: T; onChoose: (id: T) => void; label: string; prefix?: string }) {
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
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
          {t.mark && <span className="tab-mark" title={t.mark} aria-label={t.mark} />}
        </button>
      ))}
    </div>
  );
}

/**
 * One tab of an agent's page (PageTabs): its address is #/<id>. `count` shows beside its name ("Loose files 34"),
 * `mark` puts a dot there with these words on hover (something in it needs you).
 */
export interface PageTab {
  /** Letters, digits and dashes: it's part of the address. Never "settings", "about" or "tour", the kit's own. */
  id: string;
  label: string;
  count?: number;
  mark?: string;
  content: ReactNode;
}

/** The page's tab the address names (#/<id>), or null: at #/, and at the kit's own #/settings, #/about and #/tour. */
export const pageTabInHash = (hash: string): string | null => {
  const id = /^#\/?([\w-]+)$/.exec(hash)?.[1] ?? null;
  return id === 'settings' || id === 'about' || id === 'tour' ? null : id;
};

/** What the tour sends (its detail a tab's id) to bring a part of the page in a hidden tab into view (tour.tsx). */
export const SHOW_TAB = 'kit-show-tab';

/**
 * Which of the page's tabs is chosen, kept in the address (#/<id>): the one it names, else the one chosen last (so
 * Settings and back keep it), else the first. Choosing replaces the address, so Back still leaves the page; but not
 * while the tour is over the page (#/tour), whose address it would end.
 */
export function usePageTab(ids: readonly string[]): [string, (id: string) => void] {
  const [tab, setTab] = useState(() => {
    const want = pageTabInHash(globalThis.location?.hash ?? '');
    return want && ids.includes(want) ? want : ids[0];
  });
  useEffect(() => {
    const change = () => {
      const want = pageTabInHash(location.hash);
      if (want && ids.includes(want)) setTab(want);
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, [ids.join(' ')]);
  const choose = (id: string) => {
    setTab(id);
    if (!/^#\/?(tour|settings|about)\b/.test(location.hash)) history.replaceState(null, '', `#/${id}`);
  };
  return [ids.includes(tab) ? tab : ids[0], choose];
}

/**
 * An agent's page in tabs, for a page too long for one column: put it in the page's body, after what should show
 * whatever the tab (a summary). Each tab's panel is drawn and kept while hidden, so what's typed or ticked in one
 * stays, and the tour finds every part (it shows the tab a part is in: SHOW_TAB). A short page needs none.
 */
export function PageTabs({ tabs, label = 'Sections' }: { tabs: PageTab[]; label?: string }) {
  const ids = tabs.map((t) => t.id);
  const [tab, choose] = usePageTab(ids);
  useEffect(() => {
    const show = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (ids.includes(id)) choose(id);
    };
    window.addEventListener(SHOW_TAB, show);
    return () => window.removeEventListener(SHOW_TAB, show);
  }, [ids.join(' ')]);
  return (
    <>
      <Tabs tabs={tabs} tab={tab} onChoose={choose} label={label} prefix="page" />
      {tabs.map((t) => (
        <div key={t.id} className="tab-panel" role="tabpanel" id={`page-panel-${t.id}`} aria-labelledby={`page-tab-${t.id}`} hidden={t.id !== tab}>
          {t.content}
        </div>
      ))}
    </>
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
    const want = settingsTabInHash(globalThis.location?.hash ?? '');
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
