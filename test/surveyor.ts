// How the Surveyor reads a line of the Steward's serve.log: copied from Surveyor src/logs.ts:49 (ERROR_RE) and :57
// (NOT_AN_ERROR), as at its commit 9c245b89aa524cc7217bfb751b59e8aa990b7193, not imported, as it is another repository. A
// line it reads as an error is a warning on the owner's Manor, so a line that only says something is tried again, got
// round, passed over or planned mustn't read as one (test/round-log-words.test.ts).

const ERROR_RE =
  /\b(error|err!|errors?:|failed|failure|fatal|exception|unhandled|traceback|EPERM|EBUSY|EACCES|ENOENT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE|access is denied|permission denied|panic)\b/i;
const NOT_AN_ERROR =
  /\b0 (errors?|failed|failures)\b|\b(errors?|failed|failures)[:=]\s*0\b|\bno errors?\b|\berrors?: (none|null)\b|\berror: \|-?\s*$|\bfailureType: |\bround: alarm: |(?<!\bnot )\bok \d+ - |# Subtest: |\bnot (counted|treated) as an? (failure|error)\b/i;

/** Whether the Surveyor reads a line of the Steward's log as something going wrong (its isErrorLine). */
export const surveyorWarns = (line: string): boolean => ERROR_RE.test(line) && !NOT_AN_ERROR.test(line);

/** A round's line as serve.log has it (agent.ts' roundLog). */
export const roundLine = (line: string): string => `round: ${line}`;
