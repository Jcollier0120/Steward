import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { type Accelerator, acceleratorId, autoOrder, OWN_MEMORY_GB } from './accelerator-config.ts';
import type { Hardware } from './accelerators.ts';
import * as core from './core/index.js';

/**
 * What this PC has to run models on (`smith accelerators`, `reeve accelerators`): its graphics cards as DXGI lists them,
 * named the way Heiward names them (HEI.Core/Utils/GpuAdapters.cs), its NPU (the Hexagon driver,
 * through WMI) and its processor. Parsing is separate from asking Windows, so tests run on fixtures.
 */

/** One adapter as DXGI describes it, before the software ones are left out and it is named. */
export interface DxgiAdapter {
  /** Its place in DXGI's list (changes from boot to boot). */
  index: number;
  description: string;
  vendorId: number;
  dedicatedBytes: number;
  sharedBytes: number;
  /** As the GPU Engine counters write it: `0x<high>_0x<low>`, lowercase. */
  luid: string;
  flags: number;
}

/** A graphics card, named as Heiward names it. */
export interface GpuCard {
  index: number;
  /** DXGI's description, and " #2" on the second card of the same name: what identifies it. */
  name: string;
  id: string;
  vendorId: number;
  vendor: string;
  dedicatedBytes: number;
  sharedBytes: number;
  luid: string;
  /** Its own memory in GB, to one decimal. */
  memoryGb: number;
}

export interface Detection {
  cards: GpuCard[];
  npu: { name: string; device: string; driver: string; driverDate: string } | null;
  /** GenieX's program, when it's installed. */
  geniex: string | null;
  cpu: { name: string; arch: 'arm64' | 'x64' | string; cores: number } | null;
  ramBytes: number;
  /** What couldn't be asked, one line each. */
  problems: string[];
}

/** Microsoft's own adapters: the Basic Render Driver (WARP), the Remote Display Adapter, Hyper-V's. */
const MICROSOFT_VENDOR = 0x1414;
const SOFTWARE_FLAG = 2; // DXGI_ADAPTER_FLAG_SOFTWARE

export const VENDORS: Record<number, string> = {
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x1022: 'AMD',
  0x8086: 'Intel',
  0x5143: 'Qualcomm',
  0x4d4f4351: 'Qualcomm', // "QCOM", as Snapdragon's Adreno reports itself
  0x1414: 'Microsoft',
};

/**
 * The PowerShell that asks Windows: DXGI's adapters (CreateDXGIFactory1, EnumAdapters1, GetDesc1, as
 * Heiward does), then the NPU's driver and the processor through WMI, as jobs/npu-health.ps1 does.
 * One line each, fields split by |, the free text last.
 */
export const DXGI_CS = `
using System;
using System.Runtime.InteropServices;
public static class ReeveDxgi {
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdapters1Fn(IntPtr self, uint index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDesc1Fn(IntPtr self, out Desc1 desc);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Desc1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  static Delegate Slot(IntPtr obj, int slot, Type t) {
    IntPtr vtable = Marshal.ReadIntPtr(obj);
    return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtable, slot * IntPtr.Size), t);
  }
  public static string[] List() {
    var lines = new System.Collections.Generic.List<string>();
    Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IntPtr factory;
    int hr = CreateDXGIFactory1(ref iid, out factory);
    if (hr < 0) throw new Exception("CreateDXGIFactory1 failed: 0x" + hr.ToString("X8"));
    try {
      // IUnknown (0-2), IDXGIObject (3-6), IDXGIFactory (7-11), then IDXGIFactory1::EnumAdapters1.
      var enumAdapters1 = (EnumAdapters1Fn)Slot(factory, 12, typeof(EnumAdapters1Fn));
      for (uint i = 0; ; i++) {
        IntPtr adapter;
        if (enumAdapters1(factory, i, out adapter) < 0) break; // DXGI_ERROR_NOT_FOUND after the last one
        try {
          // IUnknown (0-2), IDXGIObject (3-6), IDXGIAdapter (7-9), then IDXGIAdapter1::GetDesc1.
          var getDesc1 = (GetDesc1Fn)Slot(adapter, 10, typeof(GetDesc1Fn));
          Desc1 d;
          if (getDesc1(adapter, out d) >= 0)
            lines.Add(string.Format("adapter|{0}|{1}|{2}|{3}|0x{4:x8}_0x{5:x8}|{6}|{7}", i, d.VendorId, d.DedicatedVideoMemory.ToUInt64(), d.SharedSystemMemory.ToUInt64(), d.LuidHigh, d.LuidLow, d.Flags, d.Description));
        } finally { Marshal.Release(adapter); }
      }
    } finally { Marshal.Release(factory); }
    return lines.ToArray();
  }
}
`;

export const DXGI_PS = `try { Add-Type -TypeDefinition @'
${DXGI_CS}
'@; [ReeveDxgi]::List() } catch { 'problem|graphics cards: ' + $_.Exception.Message }`;

export const DETECT_PS = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
${DXGI_PS}
try {
  foreach ($d in @(Get-CimInstance -ClassName Win32_PnPSignedDriver -Filter "DeviceName LIKE '%Hexagon%'" | Sort-Object DeviceName)) {
    $date = ''; if ($d.DriverDate) { $date = ([datetime]$d.DriverDate).ToString('yyyy-MM-dd') }
    'npu|' + $d.DriverVersion + '|' + $date + '|' + $d.DeviceName
  }
} catch { 'problem|NPU: ' + $_.Exception.Message }
try {
  $p = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
  'cpu|' + $p.Architecture + '|' + $p.NumberOfLogicalProcessors + '|' + $p.Name
  'ram|' + (Get-CimInstance -ClassName Win32_ComputerSystem).TotalPhysicalMemory
} catch { 'problem|processor: ' + $_.Exception.Message }
`;

/** The `adapter|…` lines DXGI_PS prints. */
export function parseAdapters(text: string): DxgiAdapter[] {
  const out: DxgiAdapter[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^adapter\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)\|(\d+)\|(.*)$/.exec(line.trim());
    if (!m) continue;
    out.push({
      index: Number(m[1]),
      vendorId: Number(m[2]),
      dedicatedBytes: Number(m[3]),
      sharedBytes: Number(m[4]),
      luid: m[5].toLowerCase(),
      flags: Number(m[6]),
      description: m[7],
    });
  }
  return out;
}

const GB = 1024 ** 3;

/**
 * The hardware adapters, each named: Heiward's GpuAdapters.Keyed. Windows' software adapters (the
 * software flag, or Microsoft's vendor id: Basic Render, Remote Display, Hyper-V) are left out, a
 * blank name is "Graphics card <n>", and a second card of the same name (ignoring case) is "<name> #2".
 */
export function keyCards(adapters: DxgiAdapter[]): GpuCard[] {
  const seen = new Map<string, number>();
  const out: GpuCard[] = [];
  for (const a of adapters) {
    if (a.flags & SOFTWARE_FLAG || a.vendorId === MICROSOFT_VENDOR) continue;
    const base = a.description.trim() || `Graphics card ${a.index + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    const name = n === 1 ? base : `${base} #${n}`;
    out.push({
      index: a.index,
      name,
      id: acceleratorId('gpu', name),
      vendorId: a.vendorId,
      vendor: VENDORS[a.vendorId] ?? `vendor 0x${a.vendorId.toString(16)}`,
      dedicatedBytes: a.dedicatedBytes,
      sharedBytes: a.sharedBytes,
      luid: a.luid,
      memoryGb: Math.round((a.dedicatedBytes / GB) * 10) / 10,
    });
  }
  return out;
}

/** Heiward's recommendation: the most memory of its own, the first on a tie. */
export function recommendedCard(cards: GpuCard[]): GpuCard | undefined {
  return [...cards].sort((a, b) => b.dedicatedBytes - a.dedicatedBytes || a.index - b.index)[0];
}

const tm = (s: string) => s.replace(/\((R|TM|C)\)/gi, '').replace(/\s+/g, ' ').trim();

/**
 * The NPU's name as hardware.json keeps it: its device name as Windows lists it, in full, with (R) and (TM) taken
 * out and its spaces collapsed: "Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU" is
 * "Snapdragon X2 Elite Extreme - X2E94100 - Qualcomm Hexagon NPU". "NPU" when Windows gives none. It is shown
 * shorter, by its model (the core's deviceName): "Qualcomm Hexagon".
 */
export function npuName(device: string): string {
  return tm(device) || 'NPU';
}

/** Everything DETECT_PS printed. */
export function parseDetection(text: string, geniex: string | null = null): Detection {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const problems = lines.filter((l) => l.startsWith('problem|')).map((l) => l.slice('problem|'.length));
  const npuLine = lines.map((l) => /^npu\|([^|]*)\|([^|]*)\|(.*)$/.exec(l)).find(Boolean);
  const cpuLine = lines.map((l) => /^cpu\|(\d*)\|(\d*)\|(.*)$/.exec(l)).find(Boolean);
  const ram = lines.map((l) => /^ram\|(\d+)$/.exec(l)).find(Boolean);
  // Win32_Processor.Architecture: 12 is ARM64, 9 x64.
  const arch = cpuLine ? ({ '12': 'arm64', '9': 'x64', '5': 'arm', '0': 'x86' } as Record<string, string>)[cpuLine[1]] ?? `arch ${cpuLine[1]}` : '';
  return {
    cards: keyCards(parseAdapters(text)),
    npu: npuLine ? { name: npuName(npuLine[3]), device: npuLine[3], driver: npuLine[1], driverDate: npuLine[2] } : null,
    geniex,
    cpu: cpuLine ? { name: tm(cpuLine[3]) || 'Processor', arch, cores: Number(cpuLine[2]) || 0 } : null,
    ramBytes: ram ? Number(ram[1]) : 0,
    problems,
  };
}

/** GenieX's program where its installer puts it, when it's there. */
export function findGeniex(env: Record<string, string | undefined> = process.env): string | null {
  const local = env.LOCALAPPDATA ?? (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : '');
  const exe = local ? path.join(local, 'GenieX CLI', 'geniex.exe') : '';
  return exe && existsSync(exe) ? exe : null;
}

export const powershellExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Runs a PowerShell script and gives its output (stdout, then stderr). */
export function runPowerShell(script: string, timeoutMs = 60_000): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) =>
    execFile(
      powershellExe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve(`${stdout}${err && !stdout ? `\nproblem|PowerShell: ${String(stderr || err.message).split(/\r?\n/)[0]}` : ''}`),
    ),
  );
}

/**
 * This PC has no NPU, for certain: Windows was asked and listed no Hexagon driver. False when it has
 * one, and when the question itself failed (PowerShell, or the NPU's WMI query) or never got past it
 * (no processor line, which DETECT_PS prints after the NPU's): then nobody knows.
 */
export function noNpu(d: Pick<Detection, 'npu' | 'problems' | 'cpu'>): boolean {
  const pastNpu = !!d.cpu || d.problems.some((p) => p.startsWith('processor: '));
  return !d.npu && pastNpu && !d.problems.some((p) => /^(NPU|PowerShell): |^only Windows/.test(p));
}

/**
 * What this PC has, for hardware.json (accelerators.ts' rememberHardware): whether it has an NPU, and its graphics
 * cards, with the NPU's and the processor's names. Null unless both were answered: an NPU found, or none for certain
 * (noNpu), and the cards listed. A model is then never called the NPU on a PC without one, whatever model it is (the
 * core's notTheNpu), and every accelerator is named as this PC names it (the core's acceleratorName).
 */
export function hardwareOf(d: Detection): Hardware | null {
  const npuKnown = !!d.npu || noNpu(d);
  const cardsKnown = !d.problems.some((p) => /^(graphics cards|PowerShell): |^only Windows/.test(p));
  if (!npuKnown || !cardsKnown) return null;
  return {
    npu: !!d.npu,
    cards: d.cards.map((c) => ({ name: c.name, memoryGb: c.memoryGb })),
    ...(d.npu ? { npuName: d.npu.name } : {}),
    ...(d.cpu ? { cpuName: d.cpu.name } : {}),
  };
}

/** Asks this PC. */
export async function detect(run: (script: string) => Promise<string> = runPowerShell): Promise<Detection> {
  if (process.platform !== 'win32') return { cards: [], npu: null, geniex: null, cpu: null, ramBytes: 0, problems: ['only Windows is asked'] };
  return parseDetection(await run(DETECT_PS), findGeniex());
}

/** What was detected, as accelerators (no endpoints yet), in the auto order: what `setup` and the Settings page start from. */
export function detectedAccelerators(d: Detection): Accelerator[] {
  // Each is shown as Manor shows it (the core's deviceName); a card's id stays the one its DXGI name gives.
  const list: Accelerator[] = d.cards.map((c) => ({ id: c.id, kind: 'gpu' as const, name: core.deviceName(c.name), memoryGb: c.memoryGb, slots: 1, maxContextTokens: 4096, quirks: [] }));
  if (d.npu) list.push({ id: 'npu', kind: 'npu', name: core.deviceName(d.npu.name), slots: 1, maxContextTokens: 2400, quirks: [] });
  if (d.cpu) list.push({ id: 'cpu', kind: 'cpu', name: core.deviceName(d.cpu.name), slots: 1, maxContextTokens: 4096, quirks: [] });
  return autoOrder(list);
}

/** A card shares the PC's memory when it has less than 2 GB of its own. */
export const sharesMemory = (c: Pick<GpuCard, 'memoryGb'>) => c.memoryGb < OWN_MEMORY_GB;
