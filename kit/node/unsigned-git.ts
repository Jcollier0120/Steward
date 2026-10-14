/**
 * Git that signs no commit and no tag, for commits that are never pushed: the ones a repository's tests make in their
 * throwaway repositories (kit 2.71.1). The person's own `commit.gpgsign` (with `gpg.format ssh`, as the manor's owner
 * has it) starts ssh-keygen (or gpg) for every commit, and on Windows Defender scans each signing buffer: some 380 in a
 * minute of the manor's tests, and 461 in one run of the Steward's suite.
 *
 * Added to an environment the way git reads settings from it (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<n>,
 * GIT_CONFIG_VALUE_<n>, git 2.31 on), after any already there, and once: an environment that has them is left as it
 * is. The person's own settings are never touched, and nothing else of theirs is turned off.
 *
 * The Steward runs every repository's checks with it (stages/bump.ts's runChecks), so the tests it runs sign nothing;
 * test-git.ts sets it for a whole `node --test` run (`node --import=./src/kit/test-git.ts --test …`).
 */
export function unsignedGitVars(env: Record<string, string | undefined>): Record<string, string> {
  const vars: Record<string, string> = {};
  const at = (k: string) => vars[k] ?? env[k];
  let n = Number(env.GIT_CONFIG_COUNT) || 0;
  for (const key of UNSIGNED_KEYS) {
    if (Array.from({ length: n }, (_, i) => i).some((i) => at(`GIT_CONFIG_KEY_${i}`) === key && at(`GIT_CONFIG_VALUE_${i}`) === 'false')) continue;
    vars[`GIT_CONFIG_KEY_${n}`] = key;
    vars[`GIT_CONFIG_VALUE_${n}`] = 'false';
    n++;
  }
  if (Object.keys(vars).length) vars.GIT_CONFIG_COUNT = String(n);
  return vars;
}

/** `env` with unsignedGitVars added to it, in place. Returns `env`. */
export function unsignedGit<E extends Record<string, string | undefined>>(env: E): E {
  return Object.assign(env, unsignedGitVars(env));
}

/** The settings it turns off. */
export const UNSIGNED_KEYS = ['commit.gpgsign', 'tag.gpgsign'] as const;
