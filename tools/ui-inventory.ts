/**
 * What a page is actually made of: every component, how big it is, who renders it, and where the same
 * markup has been written out more than once. Ported from GamerNexus's apps/mobile scripts/ui-inventory.ts,
 * which asks the same questions of a React Native app.
 *
 *   npm run ui:inventory                       the Steward and its kit: docs/UI-INVENTORY.md and .html
 *   npm run ui:inventory -- --repo <folder>    any agent's repository, or Manor's: docs/UI-INVENTORY-<name>.*
 *   npm run ui:inventory -- --check            fail if the report is out of date
 *   npm run ui:inventory -- --strict           exit non-zero if anything crosses a threshold below
 *   npm run ui:inventory -- --ci               the gate: the size ceilings, which are RULES, not prompts
 *   npm run ui:inventory -- --tree             print the render tree and write nothing
 *
 * WHAT A COMPONENT IS HERE. The agents' pages are being moved to React; until they are, the kit's page.ts draws
 * the shell, each agent's body is HTML written in template strings (src/view.ts), and settings-panel.js builds
 * the Settings panel with h(). So a component is a named function whose body writes markup: JSX, a string or
 * template holding a tag, or an h('tag', …) call. It "renders" the components it calls or puts in its JSX, and
 * an element is a tag with its classes, written `span.badge.ok`. A ${…} or {…} inside a tag or a class is
 * written `…`: decided at run time.
 *
 * WHY. The duplication that costs is invisible while it is small: a muted line, a list of notes, a pill,
 * written out by hand in one place, then copied, then copied slightly wrong. This makes it countable:
 *
 *   - REPEATED MARKUP is the leading indicator. The same element, with the same classes, written out
 *     many times is a component nobody has extracted yet, and the report ranks those first because that
 *     is where extracting is still cheap.
 *   - COMPONENT SIZE is the lagging one. A long function is usually several components never separated.
 *     Measured in lines AND characters (below): a line here can be 400 characters long.
 *   - USE COUNT says which way to go. Used once and large: probably fine, it is a page. Used everywhere:
 *     load-bearing, change it carefully.
 *
 * It parses with TypeScript (7's native compiler, through its API) rather than grepping, so a tag in a
 * comment or a "<" in an expression is never counted, and a ${…} is known for what it is.
 *
 * IT IS A PROMPT, NOT A RULE, but for `--ci`: a finding is a question worth asking ("should this be a
 * component?"), not a defect. `--ci` enforces only the size ceilings, set well clear of the advisory sizes,
 * so it fires when a function has stopped being one component and stays quiet otherwise.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import {
  isArrowFunction,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxExpression,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isMethodDeclaration,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableStatement,
  ModifierFlags,
  type Node,
}from 'typescript/unstable/ast';
import { buildHtml } from './ui-inventory-html.ts';

const argv = process.argv.slice(2);
/** This Steward checkout: where the report is written, whichever repository it reads. */
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The repository read: this one, or `--repo <folder>`, any agent's or Manor's. Every agent's page and Manor's are
 * moving to React, so the same questions are asked of each, in JSX or template strings alike.
 */
const repoArg = argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : undefined;
if (argv.includes('--repo') && (!repoArg || !existsSync(repoArg))) {
  console.error(`--repo needs a folder that exists${repoArg ? `: ${repoArg} doesn't` : ''}.`);
  process.exit(2);
}
const ROOT = repoArg ? path.resolve(repoArg) : STEWARD;
const SELF = ROOT === STEWARD;
const NAME = path.basename(ROOT);
/** Another repository's report is the Steward's to keep: docs\UI-INVENTORY-<name>.md, never written into that repository. */
const OUT = path.join(STEWARD, 'docs', SELF ? 'UI-INVENTORY.md' : `UI-INVENTORY-${NAME}.md`);
/** The browsable view. Generated, git-ignored, opened from disk. */
const HTML_OUT = OUT.replace(/\.md$/, '.html');

/**
 * Where the UI lives. Here: the Steward's own code and the kit it hands out. Elsewhere: the whole repository. Either
 * way src\kit\ is left out: it is a copy of the Steward's kit\ (tools/kit.ts fills it), and would count the kit's
 * components again in every agent; and so are tests, builds and what the package manager installs.
 */
const ROOTS = SELF ? ['src', 'kit/node', 'kit/web'] : ['.'];
// art\ and scripts\ hold build-time tools (Manor's banners are SVG drawn by a script), not a page.
const SKIP = new Set(['src/kit', 'kit', 'test', 'tests', '__tests__', 'dist', 'build', 'out', 'artifacts', 'coverage', 'docs', 'tools', 'art', 'scripts']);
const SKIP_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage']);

/**
 * Thresholds. Deliberately generous: a report that cries about everything gets ignored.
 *
 * SIZE IS LINES OR CHARACTERS, whichever is worse. This code is written in long lines (a template line in
 * src/view.ts runs to 600 characters), so a count of lines alone calls a 9,000-character function small.
 * `size` is max(lines, characters / CHARS_PER_LINE): a function of ordinary lines is measured by its lines,
 * and one of very long lines by how many ordinary lines it would take.
 */
const CHARS_PER_LINE = 100;
const BIG_COMPONENT_LINES = 60;
/** A page assembles; it is allowed to be longer than a component before we say anything. */
const BIG_SCREEN_LINES = 150;
/** How many times an element has to repeat before it is worth naming. */
const REPEATED_MARKUP_MIN = 4;
/**
 * How many classes an element needs before its repeats are worth reporting.
 *
 * GamerNexus counts three SUBSTANTIVE Tailwind classes, because there each class is one visual decision
 * (a colour, a padding) and `flex-row items-center` is layout noise. Here the classes are named (`muted`,
 * `badge ok`, `card`): ONE class is already the whole visual decision, so one is enough. A bare `<li>` or
 * `<td>` is how HTML works, not duplication, and is not counted.
 */
const REPEATED_MARKUP_MIN_CLASSES = 1;
/** SVG drawing is artwork (look.ts's scenes): repeating `<path class="sc-line">` is how a picture is drawn. */
const DRAWING = /^(svg|g|path|circle|ellipse|rect|line|polyline|polygon|defs|clipPath|use|stop|linearGradient|radialGradient|text|tspan)$/;

/** THE CI CEILINGS, deliberately well above the advisory ones: crossing these is no longer one component. */
const CI_COMPONENT_LINES = 140;
const CI_SCREEN_LINES = 320;

interface ComponentDef {
  /** Unique: the name, or "name (file)" when another file has one of the same name. */
  key: string;
  name: string;
  /** Repo-relative, posix separators, so the doc reads the same on every machine. */
  file: string;
  line: number;
  lines: number;
  chars: number;
  /** max(lines, chars / CHARS_PER_LINE): what the thresholds read. */
  size: number;
  exported: boolean;
  /** Rendered only by code that is not a component (a route, the server): a page's root. */
  isScreen: boolean;
  /** Component keys this one renders, in source order, deduped. */
  renders: string[];
  pos: number;
  end: number;
}

interface Element {
  tag: string;
  classes: string[];
  file: string;
  line: number;
  pos: number;
}

interface Ref {
  name: string;
  file: string;
  pos: number;
}

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry.startsWith('.') || SKIP_NAMES.has(entry) || SKIP.has(rel(full))) continue;
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry) && !/\.(test|spec|d)\.[jt]sx?$/.test(entry) && !/\.config\.[jt]s$/.test(entry)) out.push(full);
  }
  return out;
}

/** A name a component can have: not a SCREAMING_CASE constant (GEAR, CSS), which is markup, not a function. */
const isComponentName = (n: string) => !/^[A-Z0-9_]+$/.test(n);

/** What stands for a ${…}: never in source text, so it can't be confused with it. */
const HOLE = '\u0001';
const TAG_START = /<([a-zA-Z]|\u0001)/;
const TAG = /<([a-zA-Z][\w:-]*|\u0001)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR = /([^\s="'/>\u0001]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** A class attribute's value as classes; a class made at run time is `…` (`card${x ? ' alarms' : ''}` is card and …). */
const classList = (v: string) => [...new Set(v.replaceAll(HOLE, ` ${HOLE} `).trim().split(/\s+/).filter(Boolean).map((c) => (c === HOLE ? '…' : c)))];

/** A string's or template's static text with each ${…} as HOLE, or null when it holds no tag. */
function skeleton(n: Node): string | null {
  let s: string | null = null;
  if (isStringLiteral(n) || isNoSubstitutionTemplateLiteral(n)) s = n.text;
  else if (isTemplateExpression(n)) s = n.head.text + n.templateSpans.map((sp) => HOLE + sp.literal.text).join('');
  return s !== null && TAG_START.test(s) ? s : null;
}

/**
 * The elements a page can have. Without this, a "<version>" or "<kit folder>" in a usage message, and the XML
 * of a scheduled task, read as markup, and the functions writing them as components.
 */
const ELEMENTS = new Set(
  (
    'a abbr address article aside audio b blockquote body br button canvas caption code col colgroup data datalist dd details dialog div dl dt em ' +
    'fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input kbd label legend li link main mark menu meta ' +
    'meter nav noscript object ol optgroup option output p picture pre progress q s samp script section select slot small source span strong style ' +
    'sub summary sup table tbody td template textarea tfoot th thead time title tr u ul var video wbr ' +
    'svg g path circle ellipse rect line polyline polygon defs clipPath use stop linearGradient radialGradient text tspan mask pattern symbol'
  ).split(' '),
);

const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));

/**
 * The elements a skeleton opens, in order. An element's name alone isn't enough: the Steward's own usage text
 * says `--branch <b>`. So a tag counts when it has attributes, is a void element (`<br>`), or is closed in the same
 * string; a tag made at run time (`<${tag} …>`) when it has attributes.
 */
function tagsIn(s: string): { tag: string; classes: string[] }[] {
  const out: { tag: string; classes: string[] }[] = [];
  for (const m of s.matchAll(TAG)) {
    const real = m[1] === HOLE ? m[2].includes('=') : ELEMENTS.has(m[1]) && (m[2].trim() !== '' || VOID.has(m[1]) || s.includes(`</${m[1]}`));
    if (!real) continue;
    const tag = m[1] === HOLE ? '…' : m[1];
    let classes: string[] = [];
    for (const a of m[2].matchAll(ATTR)) if (a[1] === 'class') classes = classList(a[2] ?? a[3] ?? a[4] ?? '');
    out.push({ tag, classes });
  }
  return out;
}

/** The text of a JSX `className` / `class`, or an h() `class`: static, or `…`. */
function classValue(v: Node | undefined): string[] {
  if (!v) return [];
  if (isStringLiteral(v) || isNoSubstitutionTemplateLiteral(v)) return classList(v.text);
  if (isJsxExpression(v) && v.expression) return classValue(v.expression);
  if (isTemplateExpression(v)) return classList(v.head.text + v.templateSpans.map((sp) => HOLE + sp.literal.text).join(''));
  return ['…'];
}

// ---------------------------------------------------------------------------- parse

const files = ROOTS.flatMap((r) => walkFiles(path.join(ROOT, r))).sort();

/**
 * The project the parser opens: exactly the files read, JavaScript and JSX too, whatever the repository's own
 * tsconfig says. Only their syntax is read, so it is written to a folder of its own, outside every repository.
 */
const projectDir = mkdtempSync(path.join(os.tmpdir(), 'ui-inventory-'));
const TSCONFIG = path.join(projectDir, 'tsconfig.json');
writeFileSync(TSCONFIG, JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false, jsx: 'preserve', noEmit: true, skipLibCheck: true, types: [] }, files }));

const api = new API({ cwd: ROOT });
const snapshot = api.updateSnapshot({ openProjects: [TSCONFIG] });
const program = snapshot.getProjects()[0]?.program;
if (!program) throw new Error(`TypeScript opened no project for ${ROOT}.`);

const defsByFile = new Map<string, ComponentDef[]>();
const elements: Element[] = [];
const refs: Ref[] = [];
/** Per file: an imported name and the repo-relative file it comes from. */
const imports = new Map<string, Map<string, string>>();
/** Per file: where each function is, so a use in a module's constant can be told from one in code. */
const functions = new Map<string, [number, number][]>();
/** Per file: where each module-level constant is (`const GEAR = icon(…)`, a scene built with .map()). */
const constants = new Map<string, [number, number][]>();

/**
 * An import's file, as this scan names it. Here src\kit\ is the kit's own copy, so it is kit\node\ or kit\web\. An
 * import may leave out its extension, or name a folder (`./Card`, `./components`), as a bundler's do.
 */
function importedFile(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(path.join(ROOT, from)), spec);
  const found = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'].map((x) => abs + x).find((p) => existsSync(p) && statSync(p).isFile());
  const r = rel(found ?? abs);
  if (SELF && r.startsWith('src/kit/web/')) return `kit/web/${r.slice('src/kit/web/'.length)}`;
  if (SELF && r.startsWith('src/kit/')) return `kit/node/${r.slice('src/kit/'.length)}`;
  return r;
}

for (const file of files) {
  const sf = program.getSourceFile(file);
  if (!sf) throw new Error(`${rel(file)} is not in the parser's project.`);
  const relFile = rel(file);
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const defs: ComponentDef[] = [];
  const imported = new Map<string, string>();
  const fns: [number, number][] = [];
  const consts: [number, number][] = [];
  let hasMarkup = false;

  const addDef = (name: string, node: Node, exported: boolean) => {
    const start = node.getStart(sf);
    const lines = lineOf(node.getEnd()) - lineOf(start) + 1;
    const chars = node.getEnd() - start;
    defs.push({ key: name, name, file: relFile, line: lineOf(start), lines, chars, size: Math.max(lines, Math.round(chars / CHARS_PER_LINE)), exported, isScreen: false, renders: [], pos: start, end: node.getEnd() });
  };
  const element = (tag: string, classes: string[], pos: number) => {
    hasMarkup = true;
    elements.push({ tag, classes, file: relFile, line: lineOf(pos), pos });
  };

  const visit = (node: Node): void => {
    if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier) && node.importClause?.namedBindings && isNamedImports(node.importClause.namedBindings)) {
      const from = importedFile(relFile, node.moduleSpecifier.text);
      if (from) for (const s of node.importClause.namedBindings.elements) imported.set(s.name.text, from);
    }

    // Markup: a tag in a string or template, an h('tag', { class }) call, or JSX.
    const sk = skeleton(node);
    if (sk) for (const t of tagsIn(sk)) element(t.tag, t.classes, node.getStart(sf));
    if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === 'h' && node.arguments[0] && isStringLiteral(node.arguments[0])) {
      const attrs = node.arguments[1];
      const cls = attrs && isObjectLiteralExpression(attrs) ? attrs.properties.find((p) => isPropertyAssignment(p) && (isIdentifier(p.name) || isStringLiteral(p.name)) && p.name.text === 'class') : undefined;
      element(node.arguments[0].text, cls && isPropertyAssignment(cls) ? classValue(cls.initializer) : [], node.getStart(sf));
    }
    if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(sf);
      if (/^[a-z]/.test(name)) {
        const cls = node.attributes.properties.find((a) => isJsxAttribute(a) && /^class(Name)?$/.test(a.name.getText(sf)));
        element(name, cls && isJsxAttribute(cls) ? classValue(cls.initializer) : [], node.getStart(sf));
      } else refs.push({ name: name.split('.')[0], file: relFile, pos: node.getStart(sf) });
    }

    // A use: a call, or a function handed to one (`.map(named)`).
    if (isCallExpression(node)) {
      const callee = node.expression;
      if (isIdentifier(callee)) refs.push({ name: callee.text, file: relFile, pos: callee.getStart(sf) });
      for (const a of node.arguments) if (isIdentifier(a)) refs.push({ name: a.text, file: relFile, pos: a.getStart(sf) });
    }

    if (isFunctionDeclaration(node) || isFunctionExpression(node) || isArrowFunction(node) || isMethodDeclaration(node)) fns.push([node.getStart(sf), node.getEnd()]);
    // A module's constant, built once as it loads, callbacks and all: look.ts's scenes call glass() in a .map().
    if (isVariableStatement(node) && node.parent === sf && node.declarationList.declarations.some((d) => d.initializer && !isArrowFunction(d.initializer) && !isFunctionExpression(d.initializer))) {
      consts.push([node.getStart(sf), node.getEnd()]);
    }

    // `function foo() { … }`, `const foo = (…) => …`, `const foo = function () { … }`
    if (isFunctionDeclaration(node) && node.name && isComponentName(node.name.text)) {
      addDef(node.name.text, node, (node.modifierFlags & ModifierFlags.Export) !== 0);
    }
    if (isVariableStatement(node)) {
      const exported = (node.modifierFlags & ModifierFlags.Export) !== 0;
      for (const d of node.declarationList.declarations) {
        if (!isIdentifier(d.name) || !isComponentName(d.name.text) || !d.initializer) continue;
        if (!isArrowFunction(d.initializer) && !isFunctionExpression(d.initializer)) continue;
        addDef(d.name.text, node.declarationList.declarations.length === 1 ? node : d, exported);
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  imports.set(relFile, imported);
  functions.set(relFile, fns);
  constants.set(relFile, consts);
  if (hasMarkup) defsByFile.set(relFile, defs);
}
api.close();
rmSync(projectDir, { recursive: true, force: true });

type Defs = Map<string, ComponentDef[]>;

/** The innermost of `defs` a position is in, or null. */
function innermost(defs: ComponentDef[] | undefined, pos: number): ComponentDef | null {
  let best: ComponentDef | null = null;
  for (const d of defs ?? []) if (pos >= d.pos && pos < d.end && (!best || d.pos >= best.pos)) best = d;
  return best;
}

/**
 * The function a definition is declared in, as [start, end), or the whole file: where its name can be used.
 * settings-panel.js has three functions named draw, one inside each of list(), records() and map().
 */
const scopeOf = (d: ComponentDef): [number, number] => {
  let best: [number, number] = [0, Infinity];
  for (const [a, b] of functions.get(d.file) ?? []) if (a <= d.pos && b >= d.end && !(a >= d.pos && b <= d.end) && b - a < best[1] - best[0]) best = [a, b];
  return best;
};

/** Which function a name means where it is used: the nearest one in scope in the same file, else the one it was imported from. */
function resolve(defs: Defs, r: Ref): ComponentDef | null {
  const local = (defs.get(r.file) ?? []).filter((d) => d.name === r.name).map((d) => ({ d, s: scopeOf(d) })).filter(({ s }) => r.pos >= s[0] && r.pos < s[1]);
  if (local.length) return local.sort((x, y) => x.s[1] - x.s[0] - (y.s[1] - y.s[0]))[0].d;
  const from = imports.get(r.file)?.get(r.name);
  return from ? (defs.get(from) ?? []).find((d) => d.name === r.name) ?? null : null;
}

/**
 * Which functions are components: one that writes markup itself, and, in a file that writes markup, one that
 * renders a component (the Settings panel's render() writes nothing itself: it puts block()s together). To a
 * fixpoint, since rendering one that renders one counts too. A route in agent.ts that calls page() is in a file
 * with no markup of its own, so it stays what it is: the server.
 */
const kept = new Set<ComponentDef>();
for (const [file, defs] of defsByFile) for (const d of defs) if (elements.some((e) => e.file === file && e.pos >= d.pos && e.pos < d.end)) kept.add(d);
for (let grew = true; grew; ) {
  grew = false;
  for (const r of refs) {
    const target = resolve(defsByFile, r);
    const owner = innermost(defsByFile.get(r.file), r.pos);
    if (target && owner && owner !== target && kept.has(target) && !kept.has(owner)) {
      kept.add(owner);
      grew = true;
    }
  }
}
for (const [file, defs] of defsByFile) defsByFile.set(file, defs.filter((d) => kept.has(d)));

const all = [...defsByFile.values()].flat();
const nameCount = new Map<string, number>();
for (const d of all) nameCount.set(d.name, (nameCount.get(d.name) ?? 0) + 1);
for (const d of all) if (nameCount.get(d.name)! > 1) d.key = `${d.name} (${d.file}:${d.line})`;
const byKey = new Map(all.map((d) => [d.key, d]));

interface Use {
  def: ComponentDef;
  file: string;
  /** The component it is used in; null in code that is not a component. */
  owner: ComponentDef | null;
  /** Used in a module's constant (GEAR = icon(…), a scene built with .map()): markup some component puts in. */
  inConstant: boolean;
}
const uses: Use[] = [];
for (const r of refs) {
  const def = resolve(defsByFile, r);
  if (!def) continue;
  // Its own name inside itself: recursion, not a use.
  const owner = innermost(defsByFile.get(r.file), r.pos);
  if (owner === def) continue;
  const within = (ranges: [number, number][] | undefined) => (ranges ?? []).some(([a, b]) => r.pos >= a && r.pos < b);
  uses.push({ def, file: r.file, owner, inConstant: within(constants.get(r.file)) });
  if (owner && !owner.renders.includes(def.key)) owner.renders.push(def.key);
}

/**
 * A page's root: rendered by the server's code (a route, the panel's start-up), and by no component. A use in a
 * module's constant (`const GEAR = icon(…)`) makes it neither: the constant is markup some component puts in.
 */
for (const d of all) {
  const u = uses.filter((x) => x.def === d);
  d.isScreen = u.some((x) => x.owner === null && !x.inConstant) && u.every((x) => x.owner === null);
}

/**
 * Named `usageOf`, not `useCount`: the react-hooks lint rule treats any `use*` function as a hook. (Kept from
 * GamerNexus, where it matters.)
 */
const usageOf = (d: ComponentDef) => {
  const per = new Map<string, number>();
  for (const u of uses) if (u.def === d) per.set(u.file, (per.get(u.file) ?? 0) + 1);
  const list = [...per.entries()].map(([file, count]) => ({ file, count }));
  return { total: list.reduce((s, f) => s + f.count, 0), files: list };
};

/** Uses from another file. A component used only in its own file is not shared. */
const externalUses = (d: ComponentDef) => usageOf(d).files.filter((f) => f.file !== d.file);

// ---------------------------------------------------------------------------- findings

all.sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));

const oversized = all.filter((d) => d.size > (d.isScreen ? BIG_SCREEN_LINES : BIG_COMPONENT_LINES));

/** Defined and never rendered from anywhere this scan reads. The kit's exports are for every agent: check them. */
const unused = all.filter((d) => !d.isScreen && usageOf(d).total === 0);

/** The shape an element is counted by: its tag and classes, as a CSS selector reads (`span.badge.ok`). */
const shapeOf = (e: Element) => [e.tag, ...[...e.classes].sort()].join('.');
const shapes = new Map<string, { count: number; files: Set<string>; where: string[] }>();
for (const e of elements) {
  if (DRAWING.test(e.tag) || e.classes.filter((c) => c !== '…').length < REPEATED_MARKUP_MIN_CLASSES) continue;
  const s = shapeOf(e);
  const v = shapes.get(s) ?? { count: 0, files: new Set<string>(), where: [] };
  v.count += 1;
  v.files.add(e.file);
  v.where.push(`${e.file}:${e.line}`);
  shapes.set(s, v);
}
const repeated = [...shapes.entries()].filter(([, v]) => v.count >= REPEATED_MARKUP_MIN).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

const shared = all
  .map((d) => ({ def: d, uses: externalUses(d) }))
  .filter((x) => x.uses.length > 0)
  .sort((a, b) => b.uses.reduce((s, u) => s + u.count, 0) - a.uses.reduce((s, u) => s + u.count, 0));

/** Components defined and used in ONE file, pages excluded: written inline and never pulled out. */
const fileLocal = all.filter((d) => !d.isScreen && externalUses(d).length === 0 && !unused.includes(d)).sort((a, b) => b.size - a.size);

/**
 * A core component: the shared vocabulary pages are written in. The kit's page.ts today; in a React app, a
 * components/ui folder (GamerNexus's convention), where the shared components belong.
 */
const isCore = (d: ComponentDef) => d.file === 'kit/node/page.ts' || /(^|\/)components\/ui\//.test(d.file);

/**
 * What each file writes BY HAND: HTML elements, as opposed to components it calls. Not a target to drive to
 * zero (a table needs `<td>`), which is why the tag breakdown is shown. the core (page.ts, components/ui) is left out: it IS the
 * vocabulary, and asking how much of it is hand-written is circular.
 */
const rawByFile = new Map<string, Map<string, number>>();
for (const e of elements) {
  if (DRAWING.test(e.tag) || isCore({ file: e.file } as ComponentDef)) continue;
  const m = rawByFile.get(e.file) ?? new Map<string, number>();
  m.set(e.tag, (m.get(e.tag) ?? 0) + 1);
  rawByFile.set(e.file, m);
}
const rawRanked = [...rawByFile.entries()]
  .map(([file, tags]) => {
    const total = [...tags.values()].reduce((s, n) => s + n, 0);
    const defs = all.filter((d) => d.file === file).length || 1;
    return { file, total, defs, perDef: total / defs, tags: [...tags.entries()].sort((a, b) => b[1] - a[1]) };
  })
  .sort((a, b) => b.perDef - a.perDef || b.total - a.total);

// ---------------------------------------------------------------------------- tree

interface TreeNode {
  name: string;
  file: string;
  lines: number;
  uses: number;
  core: boolean;
  /** "repeat" = shown in full elsewhere, "cycle" = renders itself. Both stop the walk. */
  mark: '' | 'repeat' | 'cycle';
  children: TreeNode[];
}

/**
 * The render forest, one root per page, BOTTOMING OUT AT THE CORE COMPONENTS (page.ts's, components/ui's), which are leaves:
 * a page's shape stops being interesting where it reaches the shared vocabulary. A root is always expanded,
 * even page() itself. A component seen before is marked `↑`, and one that renders itself `↺`.
 */
function treeNodes(roots: ComponentDef[]): TreeNode[] {
  const expanded = new Set<string>();
  const walk = (d: ComponentDef, ancestry: Set<string>, depth: number): TreeNode => {
    const node: TreeNode = { name: d.name, file: d.file, lines: d.size, uses: externalUses(d).reduce((s, u) => s + u.count, 0), core: isCore(d), mark: '', children: [] };
    if (ancestry.has(d.key)) return { ...node, mark: 'cycle' };
    if (node.core && depth > 0) return node;
    if (expanded.has(d.key)) return { ...node, mark: 'repeat' };
    expanded.add(d.key);
    const next = new Set([...ancestry, d.key]);
    for (const k of d.renders) node.children.push(walk(byKey.get(k)!, next, depth + 1));
    return node;
  };
  return roots.map((r) => walk(r, new Set(), 0));
}

const MARK = { '': '', repeat: '  ↑', cycle: '  ↺' } as const;

function renderTree(roots: ComponentDef[]): string[] {
  const out: string[] = [];
  const line = (n: TreeNode, prefix: string, isLast: boolean, depth: number) => {
    const branch = depth === 0 ? '' : `${prefix}${isLast ? '└── ' : '├── '}`;
    out.push(`${branch}${n.name}${n.core ? ' ●' : ''}  ${n.lines}L${depth === 0 ? `  (${n.file})` : `, ${n.uses}×`}${MARK[n.mark]}`);
    const childPrefix = depth === 0 ? '' : `${prefix}${isLast ? '    ' : '│   '}`;
    n.children.forEach((c, i) => line(c, childPrefix, i === n.children.length - 1, depth + 1));
  };
  for (const root of treeNodes(roots)) {
    line(root, '', true, 0);
    out.push('');
  }
  return out;
}

const screens = all.filter((d) => d.isScreen).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

// ---------------------------------------------------------------------------- doc

const pct = (n: number, d: number) => (d === 0 ? '0' : ((n / d) * 100).toFixed(0));
const totalLines = all.reduce((s, d) => s + d.lines, 0);
/** A Markdown link to a source file, from docs\. Angle-bracketed, so a path with "(" can't end it early. */
const link = (file: string, text = file) => `[${text}](<${path.relative(path.dirname(OUT), path.join(ROOT, file)).split(path.sep).join('/')}>)`;

/** The command that makes this report, as the report and its messages say it. */
const command = `npm run ui:inventory${SELF ? '' : ` -- --repo ${ROOT}`}`;
/** The report's own path, as the messages say it: from the Steward's checkout. */
const outName = path.relative(STEWARD, OUT).split(path.sep).join('/');

function buildDoc(): string {
  const L: string[] = [];
  L.push(`# UI inventory: ${SELF ? 'the Steward and its kit' : NAME}`, '', `Generated by \`${command}\` (the Steward's tools/ui-inventory.ts). Do not edit by hand.`, '');
  L.push(
    "Every finding here is a QUESTION, not a defect. The thresholds are heuristics over this code's",
    'conventions, and a component can be large, or used once, for a perfectly good reason. What the',
    'report is for is catching the case where it is NOT - early, while extracting is still cheap.',
    '',
  );
  L.push('## Summary', '', '| | |', '|---|---|');
  L.push(`| Components defined | ${all.length} |`);
  L.push(`| Of those, pages (rendered only by the server) | ${screens.length} |`);
  L.push(`| Files scanned | ${files.length} (${defsByFile.size} with markup) |`);
  L.push(`| Lines in components | ${totalLines} |`);
  L.push(`| Shared (used outside their own file) | ${shared.length} (${pct(shared.length, all.length)}%) |`);
  L.push(`| Over the size threshold | ${oversized.length} |`);
  L.push(`| Defined but never used | ${unused.length} |`);
  L.push(`| Markup repeated ${REPEATED_MARKUP_MIN}+ times | ${repeated.length} |`, '');

  L.push('## Repeated markup', '');
  L.push(
    `The same element - its tag and its classes, order-insensitive - written out ${REPEATED_MARKUP_MIN}+ times. A bare tag (\`<li>\`,`,
    '`<td>`) is how HTML works and is not counted, nor is SVG drawing. `…` is a class or tag decided at run time.',
    '',
    'THIS IS THE LEADING INDICATOR. A set of visual decisions written out this many times is a component nobody',
    'has extracted yet, and those are the ones that get copied slightly wrong.',
    '',
  );
  if (repeated.length === 0) L.push('_Nothing repeated above the threshold._');
  else {
    L.push('| n | files | element | first seen |', '|---:|---:|---|---|');
    for (const [s, v] of repeated.slice(0, 40)) L.push(`| ${v.count} | ${v.files.size} | \`${s}\` | ${v.where[0]} |`);
  }
  L.push('');

  L.push('## Largest components', '');
  L.push(
    `Over ${BIG_COMPONENT_LINES} for a component, ${BIG_SCREEN_LINES} for a page. Size is lines, or characters / ${CHARS_PER_LINE} when that is more:`,
    'a long line is still code someone has to read.',
    '',
  );
  if (oversized.length === 0) L.push('_Nothing over the threshold._');
  else {
    L.push('| size | lines | uses | component | file |', '|---:|---:|---:|---|---|');
    for (const d of oversized) L.push(`| ${d.size} | ${d.lines} | ${d.isScreen ? 'page' : usageOf(d).total} | \`${d.name}\` | ${link(d.file, `${d.file}:${d.line}`)} |`);
  }
  L.push('');

  L.push('## Most reused', '', 'Load-bearing: a change here reaches every one of these files. Worth a test, and worth reading twice.', '');
  if (shared.length === 0) L.push('_Nothing is used outside its own file._');
  else {
    L.push('| uses | files | component | size | defined in |', '|---:|---:|---|---:|---|');
    for (const { def, uses: u } of shared.slice(0, 30)) L.push(`| ${u.reduce((s, x) => s + x.count, 0)} | ${u.length} | \`${def.name}\` | ${def.size} | ${link(def.file)} |`);
  }
  L.push('');

  L.push('## File-local components', '');
  L.push(
    'Defined and used in ONE file, pages excluded. Not every one should move: a helper that only makes sense',
    'next to its caller is fine where it is. The big ones are the ones to look at, which is why this is by size.',
    '',
  );
  if (fileLocal.length === 0) L.push('_None._');
  else {
    L.push('| size | component | file |', '|---:|---|---|');
    for (const d of fileLocal.slice(0, 40)) L.push(`| ${d.size} | \`${d.name}\` | ${link(d.file, `${d.file}:${d.line}`)} |`);
  }
  L.push('');

  L.push('## Defined but never used', '');
  L.push("Nothing this scan reads renders these. The kit's exports are for every agent, so check the agents before deleting one.", '');
  if (unused.length === 0) L.push('_None._');
  else for (const d of unused) L.push(`- \`${d.name}\`${d.exported ? ' (exported)' : ''} - ${link(d.file, `${d.file}:${d.line}`)}  (${d.size} lines)`);
  L.push('');

  L.push('## Written by hand', '');
  L.push(
    'What each file writes as raw HTML elements rather than through a component. Not a target to drive to zero',
    '(a table needs `<td>`), which is why the tag breakdown is here. **Ordered by `per def`** (elements per',
    "component in the file), so a file of many small components doesn't look worse than one big one. page.ts",
    '(and a components/ui folder) is left out: it IS the vocabulary.',
    '',
  );
  L.push('| raw | defs | per def | file | what it writes |', '|---:|---:|---:|---|---|');
  for (const r of rawRanked.slice(0, 25)) {
    L.push(`| ${r.total} | ${r.defs} | ${Math.round(r.perDef * 10) / 10} | ${link(r.file)} | ${r.tags.slice(0, 6).map(([t, n]) => `${t} ×${n}`).join(', ')} |`);
  }
  L.push('');

  L.push('## Render tree', '');
  L.push(
    'Rooted at each page, and **bottoming out at the core components** (the kit\'s page.ts, or components/ui, marked `●`). `NN L` is the',
    "component's size and `N×` how many times it is rendered from outside its own file. A component is printed",
    'in full the first time and marked `↑` afterwards; `↺` marks recursion.',
    '',
    '```',
    ...renderTree(screens),
    '```',
    '',
  );
  return L.join('\n');
}

// ---------------------------------------------------------------------------- cli

if (argv.includes('--ci')) {
  const tooBig = all.filter((d) => d.size > (d.isScreen ? CI_SCREEN_LINES : CI_COMPONENT_LINES));
  console.log(`UI inventory gate: ${all.length} components across ${defsByFile.size} files with markup.`);
  console.log(`  size ceilings: ${CI_COMPONENT_LINES} a component, ${CI_SCREEN_LINES} a page`);
  if (tooBig.length) {
    console.error('');
    for (const d of tooBig) console.error(`  x ${d.name} is ${d.size} in ${d.file}, over the ${d.isScreen ? CI_SCREEN_LINES : CI_COMPONENT_LINES} ceiling for a ${d.isScreen ? 'page' : 'component'}. Split it.`);
    console.error(`\nRun ${command} for the full report.`);
    process.exit(1);
  }
  console.log('\nOK.');
  process.exit(0);
}

if (argv.includes('--tree')) {
  console.log(renderTree(screens).join('\n'));
  process.exit(0);
}

const doc = buildDoc();

if (argv.includes('--check')) {
  // Only the Markdown: the page carries a generated-at time. Both are git-ignored, so this is a local convenience.
  if ((existsSync(OUT) ? readFileSync(OUT, 'utf8') : '') !== doc) {
    console.error(`${outName} is out of date. Run ${command}.`);
    process.exit(1);
  }
  console.log(`${outName} is up to date.`);
  process.exit(0);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, doc);
writeFileSync(
  HTML_OUT,
  buildHtml({
    subject: SELF ? 'The Steward and its kit' : NAME,
    all,
    screens,
    shared,
    oversized,
    unused,
    fileLocal,
    repeated: repeated.map(([shape, v]) => ({ shape, count: v.count, files: v.files.size, where: v.where })),
    rawRanked,
    tree: treeNodes(screens),
    totalLines,
    usesOf: (d) => usageOf(d as ComponentDef).total,
    thresholds: { bigComponent: BIG_COMPONENT_LINES, bigScreen: BIG_SCREEN_LINES, repeatedMin: REPEATED_MARKUP_MIN, charsPerLine: CHARS_PER_LINE },
  }),
);

console.log(`UI inventory: ${all.length} components across ${defsByFile.size} files with markup (${files.length} scanned).`);
console.log(`  pages:      ${screens.length}`);
console.log(`  shared:     ${shared.length}`);
console.log(`  file-local: ${fileLocal.length}`);
console.log(`  oversized:  ${oversized.length}`);
console.log(`  unused:     ${unused.length}`);
console.log(`  repeated markup (${REPEATED_MARKUP_MIN}+): ${repeated.length}`);
if (repeated.length > 0) {
  console.log('\n  Top repeated markup - candidates for a named component:');
  for (const [s, v] of repeated.slice(0, 5)) console.log(`    ${String(v.count).padStart(3)}× across ${v.files.size} files  ${s}`);
}
console.log(`\nWrote ${outName}`);
console.log(`      ${outName.replace(/\.md$/, '.html')}   <- open this one in a browser`);

if (argv.includes('--strict') && (oversized.length > 0 || repeated.length > 0 || unused.length > 0)) {
  console.error('\n--strict: thresholds crossed (see above).');
  process.exit(1);
}
