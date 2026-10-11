// The kit's gentle pace in Windows' own terms (gentle.ts), as Heiward sets it for itself (Program.cs, Power.SetPace):
// Windows' efficiency mode (EcoQoS), a very low disk priority, and a hard cap on the processor through a job object,
// which every program the agent starts afterwards is in too. Compiled once to a DLL (gentle.ts) and loaded by the
// agent's PowerShell worker, which sets them on the agent's process from outside it.
using System;
using System.Runtime.InteropServices;

public static class KitGentle
{
    [StructLayout(LayoutKind.Sequential)]
    struct PowerThrottlingState { public uint Version; public uint ControlMask; public uint StateMask; }

    [StructLayout(LayoutKind.Sequential)]
    struct CpuRateControl { public uint ControlFlags; public uint CpuRate; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr p, int cls, ref PowerThrottlingState info, int size);
    [DllImport("ntdll.dll")] static extern int NtSetInformationProcess(IntPtr p, int cls, ref int info, int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr p);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr p, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref CpuRateControl info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr fromProcess, IntPtr h, IntPtr toProcess, out IntPtr copy, uint access, bool inherit, uint options);

    const uint PROCESS_TERMINATE = 0x0001, PROCESS_DUP_HANDLE = 0x0040, PROCESS_SET_QUOTA = 0x0100,
        PROCESS_SET_INFORMATION = 0x0200, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint JOB_OBJECT_ALL_ACCESS = 0x1F001F;
    const int ProcessPowerThrottling = 4, ProcessIoPriority = 33, JobObjectCpuRateControlInformation = 15;
    const uint EXECUTION_SPEED = 1, CPU_RATE_ENABLE = 0x1, CPU_RATE_HARD_CAP = 0x4, DUPLICATE_SAME_ACCESS = 0x2;

    /// <summary>The job holding an agent's process: named for it, so a later worker finds it again.</summary>
    public static string JobName(int pid) { return @"Local\Castellan-pace-" + pid; }

    /// <summary>
    /// Sets process <paramref name="pid"/> gentle (efficiency mode, very low disk priority, its job capped at
    /// <paramref name="capHundredths"/> hundredths of a percent of the processor) or back to normal. Each part is tried on
    /// its own; the answer says which took ("eco io cap", or "-" for one that didn't), for the agent's log.
    /// </summary>
    public static string Set(int pid, bool gentle, int capHundredths)
    {
        IntPtr p = OpenProcess(PROCESS_TERMINATE | PROCESS_DUP_HANDLE | PROCESS_SET_QUOTA | PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (p == IntPtr.Zero) return "no-process:" + Marshal.GetLastWin32Error();
        try
        {
            var eco = new PowerThrottlingState { Version = 1, ControlMask = EXECUTION_SPEED, StateMask = gentle ? EXECUTION_SPEED : 0 };
            bool ecoOk = SetProcessInformation(p, ProcessPowerThrottling, ref eco, Marshal.SizeOf(typeof(PowerThrottlingState)));
            // Very low (0) in the background; normal (2) otherwise.
            int io = gentle ? 0 : 2;
            bool ioOk = NtSetInformationProcess(p, ProcessIoPriority, ref io, 4) >= 0;
            return (ecoOk ? "eco" : "-") + " " + (ioOk ? "io" : "-") + " " + (Cap(p, pid, gentle, capHundredths) ? "cap" : "-");
        }
        finally { CloseHandle(p); }
    }

    // The cap is on a job of the agent's own, made the first time it's gentle. Its handle is copied into the agent's
    // process, so the job and its name last as long as the agent does: a later worker opens it by name to lift the cap
    // for a round someone asked for, or set it again. A process can't leave a job, so lifting is the cap switched off.
    static bool Cap(IntPtr p, int pid, bool gentle, int capHundredths)
    {
        IntPtr job = OpenJobObject(JOB_OBJECT_ALL_ACCESS, false, JobName(pid));
        if (job == IntPtr.Zero)
        {
            if (!gentle) return true;
            job = CreateJobObject(IntPtr.Zero, JobName(pid));
            if (job == IntPtr.Zero) return false;
            bool inJob;
            if (!IsProcessInJob(p, job, out inJob) || !inJob)
            {
                IntPtr kept;
                if (!AssignProcessToJobObject(job, p) || !DuplicateHandle(GetCurrentProcess(), job, p, out kept, 0, false, DUPLICATE_SAME_ACCESS))
                {
                    CloseHandle(job);
                    return false;
                }
            }
        }
        try
        {
            var rate = gentle
                ? new CpuRateControl { ControlFlags = CPU_RATE_ENABLE | CPU_RATE_HARD_CAP, CpuRate = (uint)Math.Max(100, Math.Min(10000, capHundredths)) }
                : new CpuRateControl { ControlFlags = 0, CpuRate = 0 };
            return SetInformationJobObject(job, JobObjectCpuRateControlInformation, ref rate, Marshal.SizeOf(typeof(CpuRateControl)));
        }
        finally { CloseHandle(job); }
    }
}
