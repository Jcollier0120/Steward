import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locksDir } from './lock.ts';

/**
 * The kit's C# helpers, shipped compiled and signed with the manor's certificate (kit 2.91.0): Smart App Control
 * blocks a program it hasn't seen before unless it's signed, and a helper each PC compiles itself is one it has never
 * seen (a checks-pace launcher was blocked eight times in two seconds on 2026-10-19). Each one is in prebuilt\, named
 * for its source; a PC copies it into the shared kit folder and runs that. When a helper's source has changed since it
 * was last signed (tools/sign-helpers.ts), there's no prebuilt copy for it, and the PC compiles it as before.
 */
export const HELPERS: Readonly<Record<'checks-pace' | 'awake' | 'gentle' | 'working-set' | 'catalog' | 'ocr-npu' | 'rerank-npu', HelperSpec>> = {
  'checks-pace': { ext: 'exe', type: 'ConsoleApplication' },
  awake: { ext: 'exe', type: 'WindowsApplication' },
  gentle: { ext: 'dll', type: 'Library' },
  'working-set': { ext: 'dll', type: 'Library' },
  catalog: { ext: 'exe', type: 'ConsoleApplication' },
  // The text reader's own model (kit 2.114.0, ocr-npu.ts): it loads ONNX Runtime for the processor it runs on, so on an
  // Arm PC it must run as Arm (the manifest), not as x64 under emulation.
  'ocr-npu': { ext: 'exe', type: 'ConsoleApplication', refs: ['System.dll', 'System.Core.dll', 'System.Drawing.dll'], manifest: 'arm64' },
  // AMD's NPU's reranker (kit 2.137.0, rerank-npu.ts): x64 alone, as AMD's NPUs are.
  'rerank-npu': { ext: 'exe', type: 'ConsoleApplication', refs: ['System.dll', 'System.Core.dll'] },
};
export type Helper = keyof typeof HELPERS;

export interface HelperSpec {
  ext: 'exe' | 'dll';
  type: 'ConsoleApplication' | 'WindowsApplication' | 'Library';
  /** The assemblies it's compiled against, when Add-Type's own aren't enough. */
  refs?: readonly string[];
  /** 'arm64': compiled with ARM64_MANIFEST, so Windows on Arm runs it as Arm. */
  manifest?: 'arm64';
}

/**
 * A program's manifest that lets Windows on Arm run a .NET Framework program as Arm when its parent is Arm (as an x64
 * program when it isn't), instead of always as x64 under emulation.
 */
export const ARM64_MANIFEST = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <assemblyIdentity version="1.0.0.0" name="kit.helper"/>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <supportedArchitectures xmlns="http://schemas.microsoft.com/SMI/2024/WindowsSettings">amd64 arm64</supportedArchitectures>
    </windowsSettings>
  </application>
</assembly>
`;

/** The certificate the prebuilt helpers are signed with: the owner's, from Certum (CN=Jeremy Collier). */
export const SIGNED_BY = '6B654D9C34800D4307D42ACD63B925EDA5CE8D33';

/**
 * A helper's source and output type, hashed with plain line ends: a checkout's CRLF names the same helper. Its
 * references and manifest, when it has them, are hashed too (the helpers before kit 2.114.0 have neither, and keep
 * their names).
 */
export function helperHash(helper: Helper, source: string): string {
  const h = HELPERS[helper];
  const extra = h.refs || h.manifest ? `\n${(h.refs ?? []).join(',')}\n${h.manifest ? ARM64_MANIFEST : ''}` : '';
  return createHash('sha256').update(`${h.type}\n${source.replace(/\r\n/g, '\n')}${extra}`).digest('hex').slice(0, 12);
}

/**
 * The PowerShell that compiles a helper with references or a manifest from its source file to `out` (Add-Type with
 * CompilerParameters, as Add-Type's own -OutputType can't take either); the manifest is written beside `out` first.
 * Throws when the compiler does.
 */
export function compileHelperScript(helper: Helper, sourceFile: string, out: string): string {
  const h = HELPERS[helper];
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const manifest = `${out}.manifest`;
  return [
    '$ErrorActionPreference = "Stop"',
    h.manifest ? `[IO.File]::WriteAllText(${q(manifest)}, ${q(ARM64_MANIFEST)})` : '',
    '$cp = New-Object System.CodeDom.Compiler.CompilerParameters',
    `$cp.GenerateExecutable = $${h.type !== 'Library'}`,
    `$cp.OutputAssembly = ${q(out)}`,
    ...(h.refs ?? []).map((r) => `[void]$cp.ReferencedAssemblies.Add(${q(r)})`),
    `$cp.CompilerOptions = ${q(`/optimize+${h.type === 'WindowsApplication' ? ' /target:winexe' : ''}${h.manifest ? ` /win32manifest:"${manifest}"` : ''}`)}`,
    `try { Add-Type -TypeDefinition ([IO.File]::ReadAllText(${q(sourceFile)})) -CompilerParameters $cp } finally { Remove-Item -LiteralPath ${q(manifest)} -Force -ErrorAction SilentlyContinue }`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The prebuilt helper's file name for this source: checks-pace-0123456789ab.exe. */
export const prebuiltName = (helper: Helper, source: string): string => `${helper}-${helperHash(helper, source)}.${HELPERS[helper].ext}`;

/** Where the kit keeps its prebuilt helpers. */
export const PREBUILT_DIR = fileURLToPath(new URL('./prebuilt/', import.meta.url));

/**
 * The signed helper for this source, copied into the shared kit folder (to a name of its own, then moved into place,
 * so two agents copying at once never start a half-written one), where no agent's update can be held up by it running;
 * null when the kit has none for this source, so the caller compiles it. Never throws.
 */
export function signedHelper(helper: Helper, source: string, o: { from?: string; into?: string } = {}): string | null {
  try {
    const name = prebuiltName(helper, source);
    const from = path.join(o.from ?? PREBUILT_DIR, name);
    if (!existsSync(from)) return null;
    const into = o.into ?? path.join(path.dirname(locksDir), 'kit');
    const to = path.join(into, name.replace(/\.(exe|dll)$/, '.signed.$1'));
    if (existsSync(to)) return to;
    mkdirSync(into, { recursive: true });
    const tmp = `${to}.${process.pid}.${Date.now()}.tmp`;
    copyFileSync(from, tmp);
    try {
      renameSync(tmp, to);
    } catch {
      rmSync(tmp, { force: true });
    }
    return existsSync(to) ? to : null;
  } catch {
    return null;
  }
}
