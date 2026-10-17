/**
 * The kit, as a second version in the Steward's own repository: kit/VERSION, with its own changelog
 * (kit/CHANGELOG.md), its own releases (kit-v<version>) and its own claims (claims.ts, under `<repo>#kit`). A PR that
 * changes the kit raises both, the Steward's and the kit's (or writes kit/changes/, which a build stamps: stages/stamp.ts).
 */

export const KIT_VERSION_FILE = 'kit/VERSION';
export const KIT_CHANGELOG = 'kit/CHANGELOG.md';

/** The claims ledger's key for a repository's kit, beside the repository's own. */
export const kitClaimKey = (repo: string) => `${repo}#kit`;

/** The kit versions open PRs set, read from their titles ("Steward 0.21.3, kit 2.36.1: …", "Kit 2.32.0: …"). */
export const kitTitleVersions = (titles: string[]): string[] => titles.flatMap((t) => [.../\bkit (\d+\.\d+\.\d+)\b/i.exec(t)?.slice(1, 2) ?? []]);

/** kit/VERSION's text for a version, with the line ending the file had. */
export const kitVersionText = (version: string, was = '') => `${version}${was.includes('\r\n') ? '\r\n' : '\n'}`;

/** kit.json pinning `to`, whatever it pins now (the Steward pins its own kit); null when it pins none, or `to` already. */
export function repinKit(text: string, to: string): string | null {
  const re = /("kit"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  const m = re.exec(text);
  return m && m[2] !== to ? text.replace(re, `$1${to}$3`) : null;
}
