/**
 * Takes out anything that looks like a secret before a command's output leaves this PC in an issue (work.ts): tokens
 * with a known prefix, key=value secrets, credentials in URLs, private key blocks, and long opaque strings (mixed-case
 * letters and digits, or long hex). The Aletaster's rules (its src/redact.ts), so the manor's issues are cleaned alike.
 */
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted key]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization)(\s*[:=]\s*)(?:bearer\s+)?(["']?)[^\s"']{4,}\3/gi, '$1$2[redacted]'],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [redacted]'],
  [/\b[0-9a-fA-F]{40,}\b/g, '[redacted]'],
];

const opaque = (s: string) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);

export function redact(text: string): string {
  const t = RULES.reduce((acc, [re, to]) => acc.replace(re, to), text);
  return t.replace(/(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9+_=-])/g, (m) => (opaque(m) ? '[redacted]' : m));
}

/** The end of a command's output for an issue: its last `lines` lines, each cut at 300 characters, at most `chars` in all, redacted. */
export function trimmed(output: string, lines = 60, chars = 6000): string {
  const kept = output
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => (l.length > 300 ? `${l.slice(0, 299)}…` : l))
    .join('\n')
    .trim()
    .split('\n')
    .slice(-lines)
    .join('\n');
  const cut = kept.length > chars ? `…${kept.slice(-chars)}` : kept;
  return redact(cut);
}
