import type { Changed } from '../affected.ts';
import { gitMaybe } from '../git.ts';
import type { Ctx } from './common.ts';
import { releasedTree } from './trialpass.ts';

/**
 * What a new kit changes for one agent, for its trial (trial.ts): the files it takes from the kit that differ between
 * the kit its branch pins (that kit's release, the tag kit-v<kit>) and the kit under trial, at the paths they land in
 * the agent (as tools/kit.ts fills them). An agent none of whose files change isn't tried at all: its checks would run
 * the same code as on its own main. One whose files change runs only the tests those files reach (affected.ts). The
 * rollout's bump, once the kit is released, asks the same of the kit's tag (rollout.ts, 0.35.61): it runs those tests,
 * or none but the fill, typecheck and pretest where nothing it takes changes. Anything that can't be worked out runs whole.
 */

/** What each part needs, as tools/kit.ts fills them: node runs the core, the core takes the spec's rules, and so on. */
const NEEDS: Record<string, string[]> = { node: ['core'], core: ['spec'], dotnet: ['core'], react: ['node', 'web'] };
/** Where each part lands in an agent (tools/kit.ts's PARTS, under src/kit). */
const LANDS: Record<string, string> = { node: 'src/kit', web: 'src/kit/web', spec: 'src/kit/spec', core: 'src/kit/core', dotnet: 'src/kit/dotnet', react: 'src/kit/react' };

/** The parts an agent's kit.json takes (a Node agent's three when it names none) and the parts they need. Pure. */
export function partsTaken(pinned: string[] | null): string[] {
  const parts = [...(pinned ?? ['node', 'web', 'spec'])];
  for (let i = 0; i < parts.length; i++) for (const need of NEEDS[parts[i]] ?? []) if (!parts.includes(need)) parts.push(need);
  return parts;
}

/**
 * Where a file of the kit tree lands in an agent taking `parts` (node/npu.ts at src/kit/npu.ts, LICENSE at
 * src/kit/LICENSE), or null for one it doesn't get or that changes with every kit: VERSION, the changelog, the kit's own
 * tests, a part it doesn't take. Pure.
 */
export function landsAt(kitPath: string, parts: string[]): string | null {
  const p = kitPath.replace(/\\/g, '/');
  if (p === 'LICENSE') return 'src/kit/LICENSE';
  const [part, ...rest] = p.split('/');
  if (!rest.length || !parts.includes(part) || !(part in LANDS)) return null;
  return `${LANDS[part]}/${rest.join('/')}`;
}

export type KitReach = { none: string } | { files: Changed[]; why: string } | { all: string };

/**
 * What the kit at `head` of the Steward's clone `repo` changes for an agent pinning `pin`: nothing it takes (`none`),
 * these files (`files`), or everything (`all`): its tools/kit.ts changes (`toolChanged`), or the pinned kit's release
 * can't be read.
 */
export async function kitReach(ctx: Ctx, o: { repo: string; head: string; pin: { kit: string; parts: string[] | null }; toolChanged: boolean }): Promise<KitReach> {
  if (o.toolChanged) return { all: 'its tools/kit.ts changes too' };
  const from = await releasedTree(ctx, o.pin.kit);
  if (!from) return { all: `kit ${o.pin.kit}'s release couldn't be read` };
  const names = await gitMaybe(ctx.run, o.repo, 'diff', '--name-status', '--no-renames', from, `${o.head}:kit`);
  if (names === null) return { all: `git couldn't compare kit ${o.pin.kit} with this one` };
  const parts = partsTaken(o.pin.parts);
  const files: Changed[] = [];
  for (const line of names.split('\n')) {
    const [status, file] = line.trim().split('\t');
    const at = status && file ? landsAt(file, parts) : null;
    if (at) files.push({ status, path: at });
  }
  if (!files.length) return { none: `nothing it takes from the kit (${parts.join(', ')}) changes from ${o.pin.kit}` };
  return { files, why: `${files.length} of the kit's files it takes change from ${o.pin.kit}` };
}
