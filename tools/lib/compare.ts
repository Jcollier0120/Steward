/**
 * Which files the hires share: the comparison behind the kit (tools/kit-from.ts). Each tree is one hire's
 * files, path to text with CRLF made LF.
 */

export interface Tree {
  /** The hire's id (its package.json name): what "the same but for the agent's name" replaces. */
  id: string;
  files: Map<string, string>;
}

export interface Near {
  path: string;
  /** The hires in the largest group of identical copies. */
  same: string[];
  /** The others, each different from that group. */
  differ: string[];
}

export interface Comparison {
  /** In every tree, byte for byte the same: kit files. */
  kit: string[];
  /** In every tree, the same once each hire's own id (and its upper-case form) is taken out. */
  sameButName: string[];
  /** In every tree, and the same in most of them, but not all. */
  near: Near[];
  /** The same in every tree, but the project's own files, which stay with each hire. */
  project: string[];
  /** Everything else, each in at least one tree. */
  perAgent: string[];
}

/** A project's own files: the same in every hire today, but each hire's to change. */
export const PROJECT_FILES = ['.gitignore', 'tsconfig.json', 'package.json', 'package-lock.json', 'README.md', 'LICENSE'];
const isProjectFile = (p: string) => PROJECT_FILES.includes(p) || p.startsWith('art/');

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with a hire's id, and its upper-case environment form (PORTER_HOME), made neutral. */
export function withoutName(text: string, id: string): string {
  const env = id.toUpperCase().replace(/-/g, '_');
  return text.replace(new RegExp(escape(env), 'g'), '<ID>').replace(new RegExp(escape(id), 'g'), '<id>');
}

export function compareTrees(trees: Tree[]): Comparison {
  const out: Comparison = { kit: [], sameButName: [], near: [], project: [], perAgent: [] };
  const paths = [...new Set(trees.flatMap((t) => [...t.files.keys()]))].sort();
  for (const p of paths) {
    const holders = trees.filter((t) => t.files.has(p));
    if (holders.length < trees.length || trees.length < 2) {
      out.perAgent.push(p);
      continue;
    }
    const texts = holders.map((t) => t.files.get(p)!);
    if (texts.every((t) => t === texts[0])) {
      (isProjectFile(p) ? out.project : out.kit).push(p);
      continue;
    }
    const neutral = holders.map((t) => withoutName(t.files.get(p)!, t.id));
    if (!isProjectFile(p) && neutral.every((t) => t === neutral[0])) {
      out.sameButName.push(p);
      continue;
    }
    const groups = new Map<string, string[]>();
    holders.forEach((t, i) => groups.set(texts[i], [...(groups.get(texts[i]) ?? []), t.id]));
    const largest = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (!isProjectFile(p) && largest.length >= 2 && largest.length * 2 >= trees.length) {
      out.near.push({ path: p, same: largest, differ: holders.map((t) => t.id).filter((id) => !largest.includes(id)) });
    } else out.perAgent.push(p);
  }
  return out;
}
