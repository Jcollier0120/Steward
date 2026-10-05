import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP, appRoot, dataDir } from '../app.ts';
import { duty } from './duty.ts';
import { lookFor, sceneSvg } from './look.ts';
import { manorLink, manorSettingsUrl } from './manor.ts';
import type { Onboarding } from './onboarding.ts';
import { loadEsbuild, type Esbuild } from './minify.ts';
import { ago, CSS, esc, lookCss, pillOf } from './page.ts';
import { roundTimes } from './schedule.ts';
import type { Handler } from './server.ts';
import { groupLabel, themes, themesCss } from './themes.ts';
import { workSection } from './work.ts';

/**
 * An agent's page drawn in the browser, with React (kit 2.21.0, the kit's `react` part). The server sends a small
 * HTML shell, with the page's first data inside it, so the page draws at once with no request of its own; the
 * browser's bundle (/page.js, from the agent's src/web/main.tsx) draws it, and fetches /api/page for each update.
 *
 * Nothing on the server is JSX: the agent's server stays TypeScript that Node runs as it is. Only the page is built:
 * by esbuild (every agent's devDependency since kit 2.17.0), on each request in a checkout, and once into the
 * release (release.ts: src/web/page.js, the .tsx sources left out).
 *
 * The look is page.ts's, class for class (its CSS, the manor's themes, the agent's scene), so a React page and a
 * string-built one look the same, and the move can go one agent at a time.
 */

/** The page's source and its built bundle, from the agent's root. */
export const PAGE_ENTRY = 'src/web/main.tsx';
export const PAGE_BUNDLE = 'src/web/page.js';

/** A theme as the Theme menu shows it. */
export interface ShellTheme {
  name: string;
  label: string;
  description: string;
  swatch: [string, string, string];
  group: string;
  groupLabel: string;
}

/** What the kit's frame of every page shows: the title bar, the off-duty notice, Settings' kit part, the footer. */
export interface PageShell {
  app: { id: string; name: string; role: string; version: string };
  /** The tab's title. */
  title: string;
  /** A round or stage is under way: the scene moves, and the page looks for news every few seconds. */
  busy: boolean;
  /** How often to look for news when not busy, in seconds (0: only after a button). */
  refreshSec: number;
  pill: { kind: 'busy' | 'off' | 'on'; text: string; title: string };
  /** The scene's SVG (look.ts), the kit's own markup. */
  scene: string;
  /** Off duty: since when, in words; null on duty. */
  offDutySince: string | null;
  manor: { name: string; url: string; theme: string; settingsUrl: string } | null;
  themes: ShellTheme[];
  /** Where this browser keeps the agent's theme, without Manor. */
  themeKey: string;
  /** "Where its work runs" (work.ts), the kit's own markup, for the Settings view. */
  work: string;
  dataDir: string;
  /** Its onboarding (onboarding.ts), drawn as the page's tour at #/tour; null for none. */
  onboarding: Onboarding | null;
}

/**
 * The agent's onboarding (onboarding.ts), from its src/onboarding.ts's ONBOARDING when it has one, read once as it
 * starts: src/onboarding.js in a release, which is built. An agent adds the file and nothing else; agent-checks.ts checks
 * it, and pageShell() puts it in the shell, unless a caller passes its own.
 */
const ONBOARDING_FILE = ['ts', 'js'].map((x) => path.join(appRoot, 'src', `onboarding.${x}`)).find((f) => existsSync(f));
const AGENT_ONBOARDING: Onboarding | null = ONBOARDING_FILE ? ((await import(pathToFileURL(ONBOARDING_FILE).href)) as { ONBOARDING?: Onboarding }).ONBOARDING ?? null : null;

/** The frame's data now. `nextAt` as page()'s: left out, the kit's own schedule's. */
export function pageShell(o: { title?: string; busy?: boolean; refreshSec?: number; nextAt?: number | string | null; onboarding?: Onboarding | null } = {}): PageShell {
  const look = lookFor(APP.id);
  const d = duty();
  const m = manorLink();
  return {
    app: { id: APP.id, name: APP.name, role: APP.role, version: APP.version },
    title: o.title ?? APP.name,
    busy: !!o.busy,
    refreshSec: o.refreshSec ?? 0,
    pill: pillOf({ look, busy: o.busy, duty: d, nextAt: o.nextAt === undefined ? roundTimes().nextRunAt : o.nextAt }),
    scene: sceneSvg(look),
    offDutySince: d.onDuty ? null : ago(d.since),
    manor: m ? { name: m.name, url: m.url, theme: m.theme, settingsUrl: manorSettingsUrl(m) } : null,
    themes: themes().map((t) => ({ name: t.name, label: t.label, description: t.description, swatch: t.swatch, group: t.group, groupLabel: groupLabel(t.group) })),
    themeKey: `${APP.id}:theme`,
    work: workSection(),
    dataDir,
    onboarding: o.onboarding === undefined ? AGENT_ONBOARDING : o.onboarding,
  };
}

/** A backslash: written as its code, so no tool on the way can read it as an escape. */
const BS = String.fromCharCode(92);

/** JSON safe inside a <script> element: no "</script>", no "<!--", and no line separator a script would end a line at. */
export const scriptJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, `${BS}u003c`)
    .split(String.fromCharCode(0x2028)).join(`${BS}u2028`)
    .split(String.fromCharCode(0x2029)).join(`${BS}u2029`);

/**
 * The page's HTML: page.ts's head (the manor's theme on <html> at first paint, the themes, the kit's CSS, the scene's
 * colour), the first data as JSON, and the bundle. `data` is what /api/page answers: { shell, body }.
 */
export function reactPage(o: { token: string; data: { shell: PageShell; body: unknown } }): string {
  const look = lookFor(APP.id);
  const m = manorLink();
  const htmlTheme = m ? `${m.theme === 'system' ? '' : ` data-theme="${esc(m.theme)}"`} data-manor="${esc(m.name)}" data-manor-url="${esc(m.url)}"` : '';
  const savedTheme = m
    ? ''
    : `\n  try { var t = localStorage.getItem(${JSON.stringify(o.data.shell.themeKey)}); if (t !== 'system' && ${JSON.stringify(themes().map((t) => t.name))}.indexOf(t) >= 0) document.documentElement.dataset.theme = t; } catch (e) { /* storage blocked: the page follows Windows */ }`;
  return `<!doctype html>
<html lang="en"${htmlTheme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="page-token" content="${esc(o.token)}">
<title>${esc(o.data.shell.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>
(function () {${savedTheme}
  document.documentElement.style.setProperty('--phase', -(Date.now() % 12000) / 1000 + 's');
})();
</script>
<style>${themesCss()}${CSS}${lookCss(look)}</style>
<link rel="stylesheet" href="/settings.css">
</head>
<body>
<div id="root"><noscript><p style="margin:24px">${esc(APP.name)}'s page is drawn by JavaScript, which this browser has turned off.</p></noscript></div>
<script type="application/json" id="page-data">${scriptJson(o.data)}</script>
<script type="module" src="/page.js"></script>
</body>
</html>`;
}

/**
 * The page's bundle: everything src/web/main.tsx imports (the kit's react part, React itself), in one browser
 * module. `nodeModules` is where React is found when the entry's own folders have none (a release's stage).
 */
export async function bundlePage(entry: string, esbuild: Esbuild, o: { minify?: boolean; nodeModules?: string } = {}): Promise<string> {
  const r = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: !!o.minify,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': JSON.stringify(o.minify ? 'production' : 'development') },
    ...(o.nodeModules ? { nodePaths: [o.nodeModules] } : {}),
    logLevel: 'silent',
  });
  const text = r.outputFiles?.[0]?.text;
  if (text === undefined) throw new Error(`the page couldn't be built: ${r.errors[0]?.text ?? 'no output'}`);
  return text;
}

/**
 * A release's page (release.ts): src/web/main.tsx bundled, minified unless `readable`, into src/web/page.js in the
 * stage; and the page's sources left out (src/web's other files and the kit's react part), since the bundle carries
 * them all and the server imports none of them (src/web/types.ts's types only). React comes from the agent's own
 * node_modules, a devDependency. Null for an agent with no React page.
 */
export async function releasePage(stage: string, root: string, esbuild: Esbuild, readable = false): Promise<{ kb: number } | null> {
  const entry = path.join(stage, PAGE_ENTRY);
  if (!existsSync(entry)) return null;
  const js = await bundlePage(entry, esbuild, { minify: !readable, nodeModules: path.join(root, 'node_modules') });
  rmSync(path.join(stage, 'src', 'web'), { recursive: true, force: true });
  rmSync(path.join(stage, 'src', 'kit', 'react'), { recursive: true, force: true });
  mkdirSync(path.join(stage, 'src', 'web'), { recursive: true });
  writeFileSync(path.join(stage, PAGE_BUNDLE), js);
  return { kb: Math.ceil(Buffer.byteLength(js) / 1024) };
}

/** The newest change under the page's sources: a checkout builds again only after one. */
function newest(dirs: string[]): number {
  let t = 0;
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else t = Math.max(t, statSync(p).mtimeMs);
    }
  };
  dirs.forEach(walk);
  return t;
}

/**
 * GET /page.js: a release's built bundle as it is; in a checkout, src/web/main.tsx built now (again after a change to
 * src/web or src/kit/react), so an edit shows on the next reload. 404 for an agent with no React page.
 */
export function pageScript(root = appRoot): Handler {
  let built: { at: number; text: string } | null = null;
  return async () => {
    const bundle = path.join(root, PAGE_BUNDLE);
    if (existsSync(bundle)) return { body: readFileSync(bundle, 'utf8'), type: 'text/javascript; charset=utf-8' };
    const entry = path.join(root, PAGE_ENTRY);
    if (!existsSync(entry)) return { json: { error: 'this agent has no React page' }, status: 404 };
    const at = newest([path.join(root, 'src', 'web'), path.join(root, 'src', 'kit', 'react')]);
    if (!built || built.at !== at) {
      const esbuild = await loadEsbuild(root);
      if ('error' in esbuild) return { body: `console.error(${JSON.stringify(esbuild.error)});`, type: 'text/javascript; charset=utf-8', status: 500 };
      try {
        built = { at, text: await bundlePage(entry, esbuild) };
      } catch (e) {
        return { body: `console.error(${JSON.stringify((e as Error).message)});`, type: 'text/javascript; charset=utf-8', status: 500 };
      }
    }
    return { body: built.text, type: 'text/javascript; charset=utf-8' };
  };
}
