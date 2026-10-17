import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { locksDir } from './lock.ts';
import { powershell, psQuote } from './ps.ts';

/**
 * A model server's working set handed back to Windows once its model has loaded (kit 2.78.13), for a server
 * that holds much it never reads again: FastFlowLM 1.0.7 (accelerators.ts' trimmedOnceLoaded). It copies its model's
 * lookup tables into ordinary private memory, the token embeddings as a whole bf16 table, and reads one row of them a
 * token. Measured on a Ryzen AI 7 350 (16 GB), each model started fresh, warmed, then trimmed:
 *
 * | Model | Working set loaded | After trim and decoding | After a 1,500-token prompt | Decoding |
 * |---|---|---|---|---|
 * | qwen3.5:2b | 3,814 MB | 171 MB | 332 MB | 22.8 to 22.9 tokens a second, before and after |
 * | gemma4-it:e2b | 6,595 MB | 173 MB | 1,628 MB | 20.7 to 21.1, before and after |
 *
 * What the NPU holds is untouched (its shared memory read 2,715 and 3,470 MB before and after). Windows keeps the trimmed
 * pages compressed in RAM, or writes them to the pagefile when it needs the room, and reads back any the server touches
 * again (gemma4-it:e2b, loaded with 322 MB available: 2,376 MB available 20 s after its trim; qwen3.5:2b started by the
 * kit: its 3,744 MB in about 1,000 MB of Windows' compression store within seconds). Touched again costs nothing to
 * see: the first request after a trim took 6,360 ms against 6,350 before it, reading nothing from disk, even after
 * 8.4 GB of other files had been read through the cache, and a 1,500-token prompt of new words read 25 MB back from
 * disk in 8,866 ms against 8,948 with nothing pushed out. The upstream fix, tables read from a mapping of the model's
 * file, is FastFlowLM#807.
 *
 * Set from outside the server by the asker's PowerShell worker, with working-set.cs compiled once to a DLL every agent
 * shares (workingSetDll()). KIT_SERVER_TRIM=0 leaves every server's working set as it is.
 */

/** The compiled helper, shared by every agent on the PC: beside the accelerators' locks, named for its source. */
export function workingSetDll(source = workingSetSource()): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  return path.join(path.dirname(locksDir), 'kit', `working-set-${hash}.dll`);
}

const workingSetSource = () => readFileSync(new URL('./working-set.cs', import.meta.url), 'utf8');

/**
 * The script that empties process `pid`'s working set and says how it went: 'trimmed <MB the working set held>', or
 * what refused it ('open 87 -1': no such process). It compiles the helper first when `source` is given, as gentle.ts
 * does: to a name of its own, then moved into place, so two agents compiling at once never load a half-written DLL.
 */
export function trimScript(pid: number, dll: string, source: string | null): string {
  const compile = source === null
    ? ''
    : `if (-not (Test-Path -LiteralPath ${psQuote(dll)})) {
  $tmp = ${psQuote(dll)} + '.' + [guid]::NewGuid().ToString('n') + '.tmp'
  Add-Type -TypeDefinition ${psQuote(source)} -OutputAssembly $tmp -OutputType Library
  try { Move-Item -LiteralPath $tmp -Destination ${psQuote(dll)} } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
`;
  return `${compile}Add-Type -LiteralPath ${psQuote(dll)}
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
$held = if ($p) { [math]::Round($p.WorkingSet64 / 1MB) } else { -1 }
[KitWorkingSet]::Empty(${pid}) + ' ' + $held`;
}

/**
 * Empties process `pid`'s working set: what the helper said ('trimmed 3814'), 'failed: <why>' when PowerShell couldn't
 * run it, or null where nothing was tried (not Windows, KIT_SERVER_TRIM=0). Never throws.
 */
export async function trimWorkingSet(pid: number, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (process.platform !== 'win32' || env.KIT_SERVER_TRIM === '0') return null;
  try {
    const source = workingSetSource();
    const dll = workingSetDll(source);
    let first: string | null = null;
    if (!existsSync(dll)) {
      mkdirSync(path.dirname(dll), { recursive: true });
      first = source;
    }
    return (await powershell(trimScript(pid, dll, first), { timeoutMs: 120_000 })).trim();
  } catch (e) {
    return `failed: ${(e as Error).message.slice(0, 300)}`;
  }
}
