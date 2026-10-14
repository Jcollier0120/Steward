// The checks pace in Windows' own terms (checks-pace.ts, kit 2.70.0): a small launcher that starts a command and every
// program it starts in a job with a hard cap on the processor and on memory, at below-normal priority, so a test run, a
// type check or an install can't take the whole processor or fill the PC's memory. Compiled once to an exe
// (checks-pace.ts) every agent on the PC shares, as gentle.cs is to a DLL. Its own command line: the limits as one word
// (cap in hundredths of a percent, then optionally ",<MB per process>,<MB for the job>,<runs at once>"), then the command
// line to run, as is.
//
// The job is one for the whole PC (Local\kit-checks-pace), opened by every launcher that runs at once, so two check runs
// side by side share the cap rather than taking it twice. A process already in a job of another family (an agent's own
// gentle job, a terminal's) can join it only while it is empty: then the command gets a job of its own with the same cap.
// The job ends what is left in it once no launcher holds it (a test's server left running, a launcher stopped on a timeout).
//
// Runs at once: a launcher takes one of a few turns for the PC (Local\kit-checks-turn-<n>, mutexes, which every process
// of the sign-in session can share whatever job it is in) before it starts its command, so check runs from different job
// families (the Steward's page, the Assayer's, Claude sessions) don't each take their cap side by side. A launcher started
// inside another's run (KIT_CHECKS_TURN set: the Assayer pacing `steward vouch`, which paces its own steps) takes no turn,
// or it would wait for itself. A turn not had within TURN_WAIT_MS is gone without: a check never waits forever.
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
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateMutex(IntPtr attributes, bool owned, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReleaseMutex(IntPtr h);

    const int JobObjectExtendedLimitInformation = 9, JobObjectCpuRateControlInformation = 15;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100, JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
    const uint WAIT_OBJECT_0 = 0, WAIT_ABANDONED_0 = 0x80;
    /// <summary>How long a launcher waits for a turn before it runs its command without one: 20 minutes.</summary>
    public const uint TURN_WAIT_MS = 20 * 60 * 1000;
    /// <summary>The environment variable a launcher sets for its command, so a launcher inside it takes no turn.</summary>
    public const string TURN_HELD = "KIT_CHECKS_TURN";
    const uint CPU_RATE_ENABLE = 0x1, CPU_RATE_HARD_CAP = 0x4;
    const uint CREATE_SUSPENDED = 0x4, BELOW_NORMAL_PRIORITY_CLASS = 0x4000;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint INFINITE = 0xFFFFFFFF;

    /// <summary>The job every launcher on the PC shares (per sign-in session).</summary>
    public const string JobName = @"Local\kit-checks-pace";

    /// <summary>The launcher's limits: the processor cap, memory per process and for the job (MB, 0 none), runs at once (0 any).</summary>
    public struct Limits { public int Cap; public long ProcessMb, JobMb; public int AtOnce; }

    /// <summary>The limits word ("1111" or "1111,6144,12288,2"); false when it isn't one.</summary>
    public static bool ParseLimits(string word, out Limits l)
    {
        l = new Limits();
        string[] parts = word.Split(',');
        if (parts.Length > 4 || !int.TryParse(parts[0], out l.Cap)) return false;
        if (parts.Length > 1 && !long.TryParse(parts[1], out l.ProcessMb)) return false;
        if (parts.Length > 2 && !long.TryParse(parts[2], out l.JobMb)) return false;
        if (parts.Length > 3 && !int.TryParse(parts[3], out l.AtOnce)) return false;
        return l.Cap >= 0 && l.ProcessMb >= 0 && l.JobMb >= 0 && l.AtOnce >= 0;
    }

    public static int Main(string[] args)
    {
        Limits limits;
        string line = Rest(Marshal.PtrToStringUni(GetCommandLineW()));
        if (args.Length < 2 || !ParseLimits(args[0], out limits) || line.Length == 0)
        {
            Console.Error.WriteLine("usage: checks-pace <cap in hundredths of a percent>[,<MB per process>,<MB for the job>,<runs at once>] <command line>");
            return 2;
        }
        // Ctrl+C goes to the command, which shares this console: the launcher waits for it to end.
        SetConsoleCtrlHandler(IntPtr.Zero, true);
        IntPtr turn = TakeTurn(limits.AtOnce);
        Environment.SetEnvironmentVariable(TURN_HELD, "1");
        try { return Run(line, limits); }
        finally { if (turn != IntPtr.Zero) { ReleaseMutex(turn); CloseHandle(turn); } }
    }

    // One of the PC's turns for check runs, or zero for none: none asked, one already held by the launcher this runs
    // inside, or none had within TURN_WAIT_MS. A mutex left by a launcher that was stopped comes free as abandoned.
    static IntPtr TakeTurn(int atOnce)
    {
        if (atOnce <= 0 || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(TURN_HELD))) return IntPtr.Zero;
        var turns = new IntPtr[Math.Min(atOnce, 32)];
        int made = 0;
        for (int i = 0; i < turns.Length; i++)
        {
            IntPtr m = CreateMutex(IntPtr.Zero, false, @"Local\" + TurnName() + "-" + i);
            if (m != IntPtr.Zero) turns[made++] = m;
        }
        if (made == 0) return IntPtr.Zero;
        if (made < turns.Length) Array.Resize(ref turns, made);
        uint got = WaitForMultipleObjects((uint)made, turns, false, TURN_WAIT_MS);
        int held = got < WAIT_OBJECT_0 + made ? (int)(got - WAIT_OBJECT_0) : got >= WAIT_ABANDONED_0 && got < WAIT_ABANDONED_0 + made ? (int)(got - WAIT_ABANDONED_0) : -1;
        for (int i = 0; i < made; i++) if (i != held) CloseHandle(turns[i]);
        return held < 0 ? IntPtr.Zero : turns[held];
    }

    // The turns' name: KIT_CHECKS_TURN_NAME, so a test's turns are its own and never wait on the PC's real check runs.
    static string TurnName()
    {
        string n = Environment.GetEnvironmentVariable("KIT_CHECKS_TURN_NAME");
        return string.IsNullOrEmpty(n) || n.IndexOf('\\') >= 0 ? "kit-checks-turn" : n;
    }

    static int Run(string line, Limits limits)
    {
        int cap = limits.Cap;
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
        IntPtr job = Joined(CreateJobObject(IntPtr.Zero, JobName), pi.hProcess, limits);
        if (job == IntPtr.Zero) job = Joined(CreateJobObject(IntPtr.Zero, null), pi.hProcess, limits);
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        if (!GetExitCodeProcess(pi.hProcess, out code)) code = 1;
        CloseHandle(pi.hProcess);
        if (job != IntPtr.Zero) CloseHandle(job);
        return (int)code;
    }

    // The job with its limits set (the cap; memory per process and for the whole job, so a runaway fails with "out of
    // memory" instead of paging the PC; the rest ended when the job closes) and the process in it; zero, and the handle
    // closed, when it couldn't be. Its priority isn't forced: the command starts below normal and its programs take that
    // class from it, but a program may still raise its own (an agent's tests of its pace do).
    static IntPtr Joined(IntPtr job, IntPtr p, Limits limits)
    {
        if (job == IntPtr.Zero) return IntPtr.Zero;
        int cap = limits.Cap;
        var limit = new ExtendedLimit();
        limit.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (limits.ProcessMb > 0)
        {
            limit.Basic.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            limit.ProcessMemoryLimit = new UIntPtr((ulong)limits.ProcessMb * 1024 * 1024);
        }
        if (limits.JobMb > 0)
        {
            limit.Basic.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            limit.JobMemoryLimit = new UIntPtr((ulong)limits.JobMb * 1024 * 1024);
        }
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
