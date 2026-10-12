import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { redact } from './redact.ts';
import { checksLogOf } from './stages/bump.ts';

/**
 * A failed step's whole output, kept beside its worktree (<worktree>.log, as a bump's checks are) once the worktree is
 * gone: for a person's look, for its alarm's reason (keptFailure), and for the issue filed for the Wright (work.ts).
 */
export function keepFailure(dir: string, step: string, code: number, output: string): void {
  try {
    writeFileSync(checksLogOf(dir), `${step} (exit ${code})\n\n${output}`);
  } catch {
    // Only the round's log has it then.
  }
}

/** Lines that never say why: npm's own wrap-up of a failed script, a script's banner, a stack frame. */
const NOISE = /^(npm (ERR!|error|warn|notice)\b|> |at .*(\(|:\d+:\d+)|Node\.js v\d)/;

/**
 * Why a step failed, as near as its output says: the last lines of its last paragraph (a command ends on what went
 * wrong), npm's wrap-up and stack frames left out, secrets taken out, each cut to a line. Empty when nothing is left.
 */
export function reasonLines(output: string, max = 3): string[] {
  const lines = output
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !NOISE.test(l));
  while (lines.length && !lines.at(-1)) lines.pop();
  const last = lines.slice(lines.lastIndexOf('') + 1);
  // A step tried again ends each try on the same error: only its last try says it.
  const end = (l: string) => l.slice(l.lastIndexOf(': ') + 2);
  return last
    .filter((l, i) => !last.slice(i + 1).some((m) => l.includes(': ') && end(m) === end(l)))
    .slice(-max)
    .map((l) => redact(l.length > 300 ? `${l.slice(0, 299)}…` : l));
}

/** What a person can do about a cause the Steward knows, by what the output says. */
const HINTS: [RegExp, string][] = [
  [/SignTool Error: No certificates were found/i, "The code-signing certificate wasn't there to sign with. A cloud certificate (Certum's SimplySign, say) is there only while you're signed in to its app: sign in, then release it."],
];

/**
 * A failed step's kept output (keepFailure, or a bump's checks): its file, the lines that say why, and a hint when
 * the Steward knows what to do about it. Null when none was kept, or it can't be read.
 */
export function keptFailure(dir: string): { log: string; why: string[]; hint: string | null } | null {
  const log = checksLogOf(dir);
  try {
    if (!existsSync(log)) return null;
    const text = readFileSync(log, 'utf8');
    // Its first line names the step and its exit, then a blank one: what the step printed follows.
    const output = text.replace(/\r/g, '').split('\n').slice(2).join('\n');
    return { log, why: reasonLines(output), hint: HINTS.find(([re]) => re.test(output))?.[1] ?? null };
  } catch {
    return null;
  }
}

/** An alarm's lines for a kept failure: what it said, what to do when the Steward knows, and where the whole of it is. */
export function failureDetail(kept: ReturnType<typeof keptFailure>, said = ''): string[] {
  if (!kept) return [];
  return [
    ...kept.why.map((l, i) => `${i ? '' : 'It ended with: '}“${l}”`),
    ...(kept.hint ? [kept.hint] : []),
    ...(said.includes(kept.log) ? [] : [`Its whole output is in ${kept.log}`]),
  ];
}
