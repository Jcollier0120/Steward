import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The routes the kit's server answers for every agent (server.ts), which an agent's own `get` and `post` leave alone.
 * An own route of the same name took the kit's place without a word: the Chronicler's shrinking card had its own
 * POST /api/stop until its 0.4.17, so `shutdown` and an update's install only stopped its shrinking, and its page
 * stayed up. serve() refuses such a route as it starts, and agent-checks.ts finds one in the agent's source first.
 */
export const KIT_ROUTES = {
  get: ['/api/ping', '/favicon.svg', '/manor-icon.svg', '/settings.js', '/settings.css', '/page.js', '/api/peer/work', '/api/peer/result'],
  post: ['/api/stop', '/api/duty', '/api/repair', '/api/page-launch'],
} as const;

/** The Settings panel's API, GET and POST: the kit's when the agent hands serve() its `settings`. */
export const SETTINGS_ROUTE = '/api/settings';

/** The agent's own routes that would take one of the kit's, as "POST /api/stop": none, as it should be. */
export function shadowedRoutes(own: { get?: Record<string, unknown>; post?: Record<string, unknown> }, settings: boolean): string[] {
  const kit = (routes: readonly string[]) => new Set<string>(settings ? [...routes, SETTINGS_ROUTE] : routes);
  const get = kit(KIT_ROUTES.get);
  const post = kit(KIT_ROUTES.post);
  return [
    ...Object.keys(own.get ?? {}).filter((r) => get.has(r)).map((r) => `GET ${r}`),
    ...Object.keys(own.post ?? {}).filter((r) => post.has(r)).map((r) => `POST ${r}`),
  ];
}

/** Every kit route by name, GET or POST, the Settings panel's too. */
const ALL = new Set<string>([...KIT_ROUTES.get, ...KIT_ROUTES.post, SETTINGS_ROUTE]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// A property named as a kit route: `'/api/stop': …` after `{`, `,` or the line's start. A ternary's `? '/api/stop' :`
// isn't one, nor is a fetch of the route.
const KEY = new RegExp(`(?:^|[{,])\\s*(['"\`])(${[...ALL].map(escape).join('|')})\\1\\s*:`, 'gm');

/**
 * The places in an agent's own source (`src`, but its copy of the kit and its web page) that name one of the kit's
 * routes as a route of their own: what serve() would refuse at start, found by reading the files, without starting
 * anything. `file` is relative to `root`, with forward slashes; `line` counts from 1.
 */
export function ownRouteClashes(root: string): { file: string; line: number; route: string }[] {
  const src = path.join(root, 'src');
  const found: { file: string; line: number; route: string }[] = [];
  if (!existsSync(src)) return found;
  const skip = new Set([path.join(src, 'kit'), path.join(src, 'web')]);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(full) && e.name !== 'node_modules') walk(full);
      } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(KEY)) {
          const at = (m.index ?? 0) + m[0].indexOf(m[1]);
          found.push({ file: path.relative(root, full).split(path.sep).join('/'), line: text.slice(0, at).split('\n').length, route: m[2] });
        }
      }
    }
  };
  walk(src);
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}
