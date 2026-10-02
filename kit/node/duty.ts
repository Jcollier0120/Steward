import { dataFile, readJson, writeJson } from './store.ts';

/**
 * On duty or off: whether the agent's scheduled rounds run. Manor's Start and Stop switch it (the
 * `start` and `stop` commands), as they do Reeve's and Heiward's. The page stays up either way, and
 * Run now still works. A new agent is on duty. It's kept in duty.json, so it survives a restart.
 */
export interface Duty {
  onDuty: boolean;
  /** When it last went on or off duty (ISO), or null if it never has. */
  since: string | null;
}

const file = () => dataFile('duty.json');

export function duty(): Duty {
  const d = readJson<Partial<Duty>>(file(), {});
  return { onDuty: d.onDuty !== false, since: typeof d.since === 'string' ? d.since : null };
}

export function setDuty(onDuty: boolean): Duty {
  const now = duty();
  if (now.onDuty === onDuty && now.since) return now;
  const next = { onDuty, since: new Date().toISOString() };
  writeJson(file(), next);
  return next;
}
