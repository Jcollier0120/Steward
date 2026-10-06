import { memo, StrictMode, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import type { PageData, PageShell, ShellTheme } from './page-data.ts';
import { SettingsForm } from './settings-form.tsx';
import { UI_CSS } from './styles.ts';
import { Tour } from './tour.tsx';
import { PostButton, ReloadProvider } from './ui.tsx';

/**
 * The kit's frame of every React page, as page.ts draws it for a string-built one, element for element and class for
 * class (page.ts's CSS styles both): the title bar (back to the manor, the agent's icon, name and role, its scene, the
 * status pill, Settings, the Theme menu, and the agent's own action, Run now), the off-duty notice, the page, the
 * Settings view at #/settings (the Settings panel and "Where its work runs"), and the footer.
 *
 * The agent gives its page as children, its title-bar action as `action`, and anything of its own for the Settings
 * view as `settings` (above the panel).
 */

/** The title bar's icons, as Heiward's and Manor's draw them: 16 × 16, in the text's colour. */
function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
const Gear = () => (
  <Icon>
    <path d="M6.9 1.8h2.2l.4 1.7 1.2.6 1.5-.9 1.6 1.6-.9 1.5.6 1.2 1.7.4v2.2l-1.7.4-.6 1.2.9 1.5-1.6 1.6-1.5-.9-1.2.6-.4 1.7H6.9l-.4-1.7-1.2-.6-1.5.9-1.6-1.6.9-1.5-.6-1.2-1.7-.4V6.9l1.7-.4.6-1.2-.9-1.5 1.6-1.6 1.5.9 1.2-.6z" />
    <circle cx="8" cy="8" r="2.2" />
  </Icon>
);
const Palette = () => (
  <Icon>
    <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c.9 0 1.5-.6 1.5-1.4 0-.9-.8-1.3-.8-2.1 0-.8.6-1.3 1.4-1.3h1.6a2.5 2.5 0 0 0 2.5-2.5C14.2 4.2 11.5 1.8 8 1.8z" />
    <circle cx="5" cy="7.2" r=".6" fill="currentColor" />
    <circle cx="7.4" cy="4.6" r=".6" fill="currentColor" />
    <circle cx="10.6" cy="5.3" r=".6" fill="currentColor" />
    <circle cx="5.3" cy="10.5" r=".6" fill="currentColor" />
  </Icon>
);
const Check = () => (
  <Icon className="ti-check">
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Icon>
);

/** The kit's own markup (the scene, "Where its work runs"), placed as it is: display: contents keeps the layout page.ts has. */
const Markup = memo(({ html }: { html: string }) => <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: html }} />);

/** The theme on <html>: data-theme, none for Match Windows. */
const currentTheme = () => document.documentElement.dataset.theme || 'system';

function ThemeItem({ t, checked, onPick }: { t: ShellTheme; checked: boolean; onPick?: () => void }) {
  const inner = (
    <>
      <span className="swatch">
        {(['sw-bg', 'sw-accent', 'sw-fg'] as const).map((c, i) => (
          <span key={c} className={c} style={{ background: t.swatch[i] }} />
        ))}
      </span>
      <span className="ti-text">
        <span className="ti-label">{t.label}</span>
        <span className="ti-desc">{t.description}</span>
      </span>
      <Check />
    </>
  );
  return onPick ? (
    <button type="button" className="theme-item" role="menuitemradio" aria-checked={checked} data-theme={t.name} onClick={onPick}>
      {inner}
    </button>
  ) : (
    <div className="theme-item" role="menuitemradio" aria-checked="true" aria-disabled="true" data-theme={t.name}>
      {inner}
    </div>
  );
}

/**
 * A menu's keys while it is open, as a menu's are: the checked item (else the first) has focus, the arrows, Home and
 * End move it, Escape closes the menu and gives focus back to its button, and Tab or a click outside closes it.
 */
function useMenuKeys(open: boolean, setOpen: (open: boolean) => void, menu: RefObject<HTMLElement | null>, btn: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const stops = () => [...(menu.current?.querySelectorAll<HTMLElement>('button.theme-item, a') ?? [])];
    (stops().find((s) => s.getAttribute('aria-checked') === 'true') ?? stops()[0])?.focus();
    const outside = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const keys = (e: KeyboardEvent) => {
      const all = stops();
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        all[e.key === 'Home' ? 0 : all.length - 1]?.focus();
      } else if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      } else if (e.key === 'Tab') setOpen(false);
    };
    document.addEventListener('click', outside);
    menu.current?.addEventListener('keydown', keys);
    const el = menu.current;
    return () => {
      document.removeEventListener('click', outside);
      el?.removeEventListener('keydown', keys);
    };
  }, [open, setOpen, menu, btn]);
}

/**
 * The Theme menu: the nine themes, kept in this browser for this agent; or, with Manor, the manor's theme and a link to
 * Manor, where it is chosen. It stays open while themes are tried.
 */
export function ThemeMenu({ shell }: { shell: PageShell }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(currentTheme);
  const menu = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const m = shell.manor;
  useMenuKeys(open, setOpen, menu, btn);
  const pick = (name: string) => {
    if (name === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = name;
    try {
      localStorage.setItem(shell.themeKey, name);
    } catch {
      // Storage blocked: it holds for this visit.
    }
    setTheme(name);
  };
  const title = m ? `Theme (${m.name}'s)` : 'Theme';
  const manorTheme = m ? (shell.themes.find((t) => t.name === m.theme) ?? shell.themes[0]) : null;
  return (
    <div className="theme-picker" id="theme-picker" data-tour="theme">
      <button ref={btn} type="button" className="icon-btn" id="theme-btn" title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} aria-controls="theme-menu" onClick={() => setOpen(!open)}>
        <Palette />
      </button>
      <div ref={menu} className="theme-menu" id="theme-menu" role="menu" aria-label="Theme" hidden={!open}>
        {m && manorTheme ? (
          <>
            <div className="menu-label">Theme</div>
            <ThemeItem t={manorTheme} checked />
            <p className="menu-note">{m.name} chooses the theme, for every page in the manor.</p>
            <a className="menu-link" role="menuitem" href={m.url}>
              Change it in {m.name}
            </a>
          </>
        ) : (
          shell.themes.map((t, i) => (
            <span key={t.name} style={{ display: 'contents' }}>
              {t.group !== shell.themes[i - 1]?.group && <div className="menu-label">{t.groupLabel}</div>}
              <ThemeItem t={t} checked={t.name === theme} onPick={() => pick(t.name)} />
            </span>
          ))
        )}
      </div>
    </div>
  );
}

/** The title bar: sticky, with a line under it once the page has scrolled, and --titlebar-h kept to its height. */
function TitleBar({ shell, settings, action }: { shell: PageShell; settings: boolean; action?: ReactNode }) {
  const bar = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const size = () => root.style.setProperty('--titlebar-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    const scrolled = () => setStuck(window.scrollY > 0);
    const ro = window.ResizeObserver ? new ResizeObserver(size) : null;
    ro?.observe(el);
    size();
    scrolled();
    window.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      ro?.disconnect();
      window.removeEventListener('scroll', scrolled);
    };
  }, []);
  const m = shell.manor;
  return (
    <header ref={bar} className={['titlebar', shell.busy ? 'busy' : '', stuck ? 'stuck' : ''].filter(Boolean).join(' ')} data-agent={shell.app.id} data-tour="titlebar">
      {m && (
        <>
          <a className="manor-back" href={m.url} title={`Back to ${m.name}`}>
            <img src="/manor-icon.svg" alt="" width="22" height="22" />
            <span>Back to {m.name}</span>
          </a>
          <span className="manor-sep" aria-hidden="true" />
        </>
      )}
      <a className="brand" href="#/">
        <img className="brand-mark" src="/favicon.svg" alt="" width="28" height="28" />
        <div className="brand-text">
          <h1>{shell.app.name}</h1>
          <p className="role">{shell.app.role}</p>
        </div>
      </a>
      <Markup html={shell.scene} />
      <div className="tools">
        <span className={`status-pill ${shell.pill.kind}`} title={shell.pill.title} data-tour="status">
          {shell.pill.text}
        </span>
        <a className="tool-link" id="settings-link" href="#/settings" title="Settings" aria-current={settings ? 'page' : 'false'} data-tour="settings">
          <Gear />
          <span>Settings</span>
        </a>
        <ThemeMenu shell={shell} />
        {action && (
          <span className="titlebar-action" data-tour="action">
            {action}
          </span>
        )}
      </div>
    </header>
  );
}

export type Route = 'page' | 'settings' | 'tour';

/** The route: the page at #/, Settings at #/settings, a tour of the page at #/tour (over the page itself; `?from=` too). */
export function useRoute(): Route {
  const read = (): Route => (/^#\/?settings$/.test(location.hash) ? 'settings' : /^#\/?tour(\?.*)?$/.test(location.hash) ? 'tour' : 'page');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const change = () => {
      const next = read();
      setRoute(next);
      if (next !== 'tour') window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('on-settings', route === 'settings');
    document.body.classList.toggle('on-tour', route === 'tour');
  }, [route]);
  return route;
}

/**
 * The whole page: the agent's own as children, in the kit's frame.
 *
 * `tour` is the page's walkthrough, drawn over the page at #/tour: by default its onboarding (the shell's, from
 * pageShell(): tour.tsx draws it), so an agent writes no tour of its own. It points at the page's parts by their
 * `data-tour` names: the frame's are titlebar, status, settings, theme, action, settings-panel and work, and an agent
 * names its own sections the same way.
 *
 * The Settings view is the kit's Settings form (settings-form.tsx), drawn again after onboarding saves.
 */
export function Page<Body>({ data, reload, action, settings, tour, children }: { data: PageData<Body>; reload: () => void | Promise<void>; action?: ReactNode; settings?: ReactNode; tour?: ReactNode; children: ReactNode }) {
  const s = data.shell;
  const route = useRoute();
  const onSettings = route === 'settings';
  const [settingsDrawn, setSettingsDrawn] = useState(0);
  const walkthrough = tour ?? (s.onboarding && <Tour onboarding={s.onboarding} app={s.app} onSettingsSaved={() => setSettingsDrawn((n) => n + 1)} />);
  return (
    <ReloadProvider value={reload}>
      <style>{UI_CSS}</style>
      <TitleBar shell={s} settings={onSettings} action={action} />
      {s.offDutySince && (
        <div className="banners">
          <div className="banner-note offduty" role="status">
            <span>
              <strong>Off duty</strong> since {s.offDutySince}: its scheduled rounds are paused. Run now still works.
            </span>
            <PostButton title="Back on duty" variant="secondary" path="/api/duty" body={{ onDuty: true }} />
          </div>
        </div>
      )}
      <main className="view">
        {children}
        <section id="settings-view">
          <a className="back-link" href="#/">
            Back to {s.app.name}
          </a>
          <h2>Settings</h2>
          {settings}
          <SettingsForm key={settingsDrawn} />
          <div data-tour="work" style={{ display: 'contents' }}>
            <Markup html={s.work} />
          </div>
        </section>
      </main>
      {route === 'tour' && walkthrough && (
        <div className="tour-layer" role="dialog" aria-label={`A tour of ${s.app.name}'s page`}>
          {walkthrough}
        </div>
      )}
      <footer>
        {s.app.name} {s.app.version} · this PC only · its files are in <code>{s.dataDir}</code>
      </footer>
    </ReloadProvider>
  );
}

/** Draws the page into the shell's #root (react-page.ts's reactPage()). */
export function mount(node: ReactNode) {
  const root = document.getElementById('root');
  if (!root) throw new Error('This page has no #root: the server sends it with the page.');
  createRoot(root).render(<StrictMode>{node}</StrictMode>);
}
