# What the graphics cards' 3D engines are doing, for the kit's game check (src/accelerators.ts, Manor's
# docs/ACCELERATORS.md "Games"). Read-only. Prints one JSON object:
#   adapters   every adapter DXGI lists (IDXGIFactory1::EnumAdapters1): its number, description, LUID,
#              own memory, vendor and whether it's a software adapter, as Heiward's GpuAdapters reads them
#   counters   "<instance>`t<percent>" lines: Windows' "GPU Engine(*engtype_3D)\Utilization Percentage",
#              two samples a second apart, by the counters' English names (PdhAddEnglishCounter), so a
#              Windows in another language reads them too
#   processes  the name of each process those instances name, by pid
#   compositor the desktop window manager's pid (dwm), which draws every window and doesn't count
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class ManorGpuLoad {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct AdapterDesc1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow;
    public int LuidHigh;
    public uint Flags;
  }

  // Only the slots before the methods used are declared, in vtable order.
  [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIAdapter1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport();
    [PreserveSig] int GetDesc1(out AdapterDesc1 desc);
  }

  [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIFactory1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();
    [PreserveSig] int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
  }

  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);

  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 0x20) b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  public static string Adapters() {
    var list = new List<string>();
    Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    object o;
    if (CreateDXGIFactory1(ref iid, out o) < 0) return "[]";
    var factory = (IDXGIFactory1)o;
    try {
      for (uint i = 0; ; i++) {
        IDXGIAdapter1 adapter;
        if (factory.EnumAdapters1(i, out adapter) < 0) break; // DXGI_ERROR_NOT_FOUND after the last one
        try {
          AdapterDesc1 d;
          if (adapter.GetDesc1(out d) < 0) continue;
          list.Add(string.Format(CultureInfo.InvariantCulture,
            "{{\"index\":{0},\"name\":{1},\"luid\":\"0x{2:x8}_0x{3:x8}\",\"dedicatedMemory\":{4},\"vendorId\":{5},\"software\":{6}}}",
            i, Json((d.Description ?? "").TrimEnd('\0')), (uint)d.LuidHigh, d.LuidLow, d.DedicatedVideoMemory.ToUInt64(), d.VendorId, (d.Flags & 2) != 0 ? "true" : "false"));
        } finally { Marshal.ReleaseComObject(adapter); }
      }
    } finally { Marshal.ReleaseComObject(factory); }
    return "[" + string.Join(",", list.ToArray()) + "]";
  }

  [StructLayout(LayoutKind.Sequential)]
  struct FmtItem { public IntPtr Name; public uint CStatus; public double Value; }

  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQuery(string source, IntPtr user, out IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounter(IntPtr query, string path, IntPtr user, out IntPtr counter);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, out uint count, IntPtr items);
  [DllImport("pdh.dll")] static extern uint PdhCloseQuery(IntPtr query);

  public static string Counters(int sampleMs) {
    IntPtr query, counter;
    if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) return "";
    try {
      if (PdhAddEnglishCounter(query, "\\GPU Engine(*engtype_3D)\\Utilization Percentage", IntPtr.Zero, out counter) != 0) return "";
      PdhCollectQueryData(query); // a utilization needs two samples
      System.Threading.Thread.Sleep(sampleMs);
      if (PdhCollectQueryData(query) != 0) return "";
      const uint Double = 0x200, NoCap100 = 0x8000;
      uint size = 0, count;
      PdhGetFormattedCounterArrayW(counter, Double | NoCap100, ref size, out count, IntPtr.Zero);
      if (size == 0) return "";
      IntPtr buf = Marshal.AllocHGlobal((int)size);
      try {
        if (PdhGetFormattedCounterArrayW(counter, Double | NoCap100, ref size, out count, buf) != 0) return "";
        var sb = new StringBuilder();
        int stride = Marshal.SizeOf(typeof(FmtItem));
        for (int i = 0; i < count; i++) {
          var item = (FmtItem)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + i * stride), typeof(FmtItem));
          if (item.CStatus != 0) continue;
          sb.Append(Marshal.PtrToStringUni(item.Name)).Append('\t').Append(item.Value.ToString("0.##", CultureInfo.InvariantCulture)).Append('\n');
        }
        return sb.ToString();
      } finally { Marshal.FreeHGlobal(buf); }
    } finally { PdhCloseQuery(query); }
  }
}
'@
$adapters = '[]'
try { $adapters = [ManorGpuLoad]::Adapters() } catch { }
$counters = ''
try { $counters = [ManorGpuLoad]::Counters(1000) } catch { }
$names = @{}
foreach ($m in [regex]::Matches($counters, '(?m)^pid_(\d+)_')) {
  $id = [int]$m.Groups[1].Value
  if ($id -gt 0 -and -not $names.ContainsKey("$id")) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p) { $names["$id"] = $p.ProcessName }
  }
}
$dwm = @(Get-Process -Name dwm -ErrorAction SilentlyContinue | Select-Object -First 1)
$rest = ConvertTo-Json -Compress -Depth 4 -InputObject ([ordered]@{
  counters   = $counters
  processes  = $names
  compositor = if ($dwm.Count) { $dwm[0].Id } else { $null }
})
# adapters is JSON already: it goes in as it is.
'{"adapters":' + $adapters + ',' + $rest.Substring(1)
