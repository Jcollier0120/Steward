// A model server's working set handed back to Windows from outside it (working-set.ts): FastFlowLM 1.0.7 copies its
// model's lookup tables (the token embeddings, Gemma 4's per-layer ones) into ordinary private memory and reads one row
// of them a token, so most of what it holds is never touched again once its model has loaded. EmptyWorkingSet takes
// those pages out of the server's working set: Windows writes them to the pagefile when it needs the room, and reads
// back any the server touches again. Compiled once to a DLL every agent shares (working-set.ts) and called by the
// agent's PowerShell worker.
using System;
using System.Runtime.InteropServices;

public static class KitWorkingSet
{
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool EmptyWorkingSet(IntPtr p);

    // PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA: what EmptyWorkingSet needs of the handle.
    const uint ACCESS = 0x0400 | 0x0100;

    // "trimmed", or what refused it: "open <error>" (no such process, or not the asker's to touch), "trim <error>".
    public static string Empty(int pid)
    {
        IntPtr h = OpenProcess(ACCESS, false, pid);
        if (h == IntPtr.Zero) return "open " + Marshal.GetLastWin32Error();
        try
        {
            return EmptyWorkingSet(h) ? "trimmed" : "trim " + Marshal.GetLastWin32Error();
        }
        finally
        {
            CloseHandle(h);
        }
    }
}
