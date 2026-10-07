/**
 * The kit, as a second version in the Steward's own repository: kit/VERSION, with its own changelog
 * (kit/CHANGELOG.md), its own releases (kit-v<version>) and its own claims (claims.ts, under `<repo>#kit`). A PR that
 * changes the kit raises both, the Steward's and the kit's, and a catch-up (stages/catchup.ts) settles both the same
 * way: the PR's own while it's still new, else the next free one above the branch's.
 */

export const KIT_VERSION_FILE = 'kit/VERSION';
export const KIT_CHANGELOG = 'kit/CHANGELOG.md';

const norm = (f: string) => f.replace(/\\/g, '/').toLowerCase();
export const isKitVersionFile = (f: string) => norm(f) === KIT_VERSION_FILE.toLowerCase();
export const isKitChangelog = (f: string) => norm(f) === KIT_CHANGELOG.toLowerCase();

/** The claims ledger's key for a repository's kit, beside the repository's own. */
export const kitClaimKey = (repo: string) => `${repo}#kit`;

/** The kit versions open PRs set, read from their titles ("Steward 0.21.3, kit 2.36.1: …", "Kit 2.32.0: …"). */
export const kitTitleVersions = (titles: string[]): string[] => titles.flatMap((t) => [.../\bkit (\d+\.\d+\.\d+)\b/i.exec(t)?.slice(1, 2) ?? []]);

/** kit/VERSION's text for a version, with the line ending the file had. */
export const kitVersionText = (version: string, was = '') => `${version}${was.includes('\r\n') ? '\r\n' : '\n'}`;

/**
 * The changelog's top entry with its mentions of the kit's version ("the kit 2.36.1", "kit 2.36.1:") moved from `from`
 * to `to`: the Steward's entry names the kit it hands out. Only the top entry, the PR's own; null when that has none.
 */
export function renameKitInTopEntry(text: string, from: string, to: string): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const top = lines.findIndex((l) => l.startsWith('## '));
  if (top < 0) return null;
  let end = lines.findIndex((l, i) => i > top && l.startsWith('## '));
  if (end < 0) end = lines.length;
  const mention = new RegExp(`\\b(kit )${from.replace(/\./g, '\\.')}\\b`, 'gi');
  let found = false;
  for (let i = top; i < end; i++) {
    const next = lines[i].replace(mention, (m, kit: string) => ((found = true), `${kit}${to}`));
    lines[i] = next;
  }
  return found ? lines.join(eol) : null;
}

/** kit.json pinning `to`, whatever it pins now (the Steward pins its own kit); null when it pins none, or `to` already. */
export function repinKit(text: string, to: string): string | null {
  const re = /("kit"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  const m = re.exec(text);
  return m && m[2] !== to ? text.replace(re, `$1${to}$3`) : null;
}
