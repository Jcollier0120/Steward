// The checks pace in Windows' own terms (checks-pace.ts, kit 2.70.0): a small launcher that starts a command and every
// program it starts in a job with a hard cap on the processor, at below-normal priority, so a test run, a type check or an
// install can't take the whole processor. Compiled once to an exe (checks-pace.ts) every agent on the PC shares, as
// gentle.cs is to a DLL. Its own command line: the cap in hundredths of a percent, then the command line to run, as is.
//
// The job is one for the whole PC (Local\kit-checks-pace), opened by every launcher that runs at once, so two check runs
// side by side share the cap rather than taking it twice. A process already in a job of another family (an agent's own
// gentle job, a terminal's) can join it only while it is empty: then the command gets a job of its own with the same cap.
// The job ends what is left in it once no launcher holds it (a test's server left running, a launcher stopped on a timeout).
using System;
using System.Runtime.InteropServices;

public static class KitChecksPace
{
    [StructLayout(LayoutKind.Sequential)]
    struct CpuRateControl { public uint ControlFlags; public uint CpuRate; }

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref CpuRateControl info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimit info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr p);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref StartupInfo si, out ProcessInformation pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetCommandLineW();

    const int JobObjectExtendedLimitInformation = 9, JobObjectCpuRateControlInformation = 15;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint CPU_RATE_ENABLE = 0x1, CPU_RATE_HARD_CAP = 0x4;
    const uint CREATE_SUSPENDED = 0x4, BELOW_NORMAL_PRIORITY_CLASS = 0x4000;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint INFINITE = 0xFFFFFFFF;

    /// <summary>The job every launcher on the PC shares (per sign-in session).</summary>
    public const string JobName = @"Local\kit-checks-pace";

    public static int Main(string[] args)
    {
        int cap;
        string line = Rest(Marshal.PtrToStringUni(GetCommandLineW()));
        if (args.Length < 2 || !int.TryParse(args[0], out cap) || line.Length == 0)
        {
            Console.Error.WriteLine("usage: checks-pace <cap in hundredths of a percent> <command line>");
            return 2;
        }
        // Ctrl+C goes to the command, which shares this console: the launcher waits for it to end.
        SetConsoleCtrlHandler(IntPtr.Zero, true);
        var si = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), dwFlags = STARTF_USESTDHANDLES, hStdInput = GetStdHandle(-10), hStdOutput = GetStdHandle(-11), hStdError = GetStdHandle(-12) };
        ProcessInformation pi;
        if (!CreateProcess(null, new System.Text.StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | BELOW_NORMAL_PRIORITY_CLASS, IntPtr.Zero, null, ref si, out pi))
        {
            int err = Marshal.GetLastWin32Error();
            Console.Error.WriteLine("checks-pace: couldn't start " + line + " (Windows error " + err + ")");
            return err == 2 || err == 3 ? 127 : 126;
        }
        // The shared job, else one of its own; and if neither takes, the command runs as it is at below-normal priority:
        // the pace never fails a check.
        IntPtr job = Joined(CreateJobObject(IntPtr.Zero, JobName), pi.hProcess, cap);
        if (job == IntPtr.Zero) job = Joined(CreateJobObject(IntPtr.Zero, null), pi.hProcess, cap);
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        if (!GetExitCodeProcess(pi.hProcess, out code)) code = 1;
        CloseHandle(pi.hProcess);
        if (job != IntPtr.Zero) CloseHandle(job);
        return (int)code;
    }

    // The job with its limits set (the cap, the rest ended when the job closes) and the process in it; zero, and the
    // handle closed, when it couldn't be. Its priority isn't forced: the command starts below normal and its programs
    // take that class from it, but a program may still raise its own (an agent's tests of its pace do).
    static IntPtr Joined(IntPtr job, IntPtr p, int cap)
    {
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var limit = new ExtendedLimit();
        limit.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(ExtendedLimit)));
        var rate = cap > 0
            ? new CpuRateControl { ControlFlags = CPU_RATE_ENABLE | CPU_RATE_HARD_CAP, CpuRate = (uint)Math.Max(100, Math.Min(10000, cap)) }
            : new CpuRateControl { ControlFlags = 0, CpuRate = 0 };
        SetInformationJobObject(job, JobObjectCpuRateControlInformation, ref rate, Marshal.SizeOf(typeof(CpuRateControl)));
        if (AssignProcessToJobObject(job, p)) return job;
        CloseHandle(job);
        return IntPtr.Zero;
    }

    /// <summary>
    /// The command line after the launcher's own path and the cap, exactly as given: the launcher's path quoted or not
    /// (Windows' rule for a program's name: up to the next quote, else the next space), the cap a word without quotes.
    /// </summary>
    public static string Rest(string line)
    {
        int i = 0;
        if (i < line.Length && line[i] == '"')
        {
            int close = line.IndexOf('"', 1);
            i = close < 0 ? line.Length : close + 1;
        }
        while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
        while (i < line.Length && (line[i] == ' ' || line[i] == '\t')) i++;
        while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
        while (i < line.Length && (line[i] == ' ' || line[i] == '\t')) i++;
        return line.Substring(i);
    }
}
