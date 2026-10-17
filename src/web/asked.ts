/**
 * What a stage was asked (StageResult.asked, steward.ts' StageAsk), in words for the page's Last stage: "Build now;
 * every employee looked at", rather than its fields as they are ("full true; buildNow [object Object]", 2026-10-17).
 */
export function askedWords(asked: Record<string, unknown>): string {
  const words: Record<string, (v: unknown) => string> = {
    buildNow: (v) => ((v as { toCustomers?: boolean } | null)?.toCustomers ? 'Build now, to customers' : 'Build now'),
    full: () => 'every employee looked at',
    employees: (v) => `for ${(v as string[]).join(', ')}`,
    look: (v) => `${(v as string[]).join(', ')} looked at too`,
    kit: (v) => `kit ${v}`,
    kitFrom: (v) => `the kit from ${v}`,
    base: (v) => `from ${v}`,
    yes: () => 'merging',
    team: () => "the team's PRs too",
    hire: () => 'a hire',
    tendOnly: () => 'only the pages kept up',
  };
  return Object.entries(asked)
    .filter(([, v]) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => (words[k] ? words[k](v) : `${k} ${plain(v)}`))
    .join('; ');
}

/** A value the page has no words for, as plain text: a list by commas, an object by its fields that are set. */
function plain(v: unknown): string {
  if (Array.isArray(v)) return v.map(plain).join(', ');
  if (v && typeof v === 'object') {
    const set = Object.entries(v).filter(([, x]) => x !== undefined && x !== null && x !== false);
    return set.length ? `(${set.map(([k, x]) => (x === true ? k : `${k} ${plain(x)}`)).join(', ')})` : '';
  }
  return String(v);
}
