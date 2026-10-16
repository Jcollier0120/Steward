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
//
// Runs in sight (kit 2.76.0): a launcher that takes part in the turns says where it stands in a file of its own,
// <KIT_CHECKS_RUNS>\<its process id>.run, so an agent's work status (work-status.ts) shows every check run on the PC:
// its first line "waiting -1 <since>" while it waits, "turn <n> <since>" once it holds turn n, "running -1 <since>" when
// it runs without one; its second KIT_CHECKS_WHO, as the agent that started it set it. Removed when it ends; one left by
// a launcher that was stopped is removed by the next reader, whose process is gone.
//
// `apart <command line>` (apart.ts) instead starts a program out of the jobs it would inherit, as far as they let it
// (an agent's gentle job does, kit 2.73.0; one that doesn't keeps it), detached, its output to the launcher's standard
// error, and answers its process id as the exit code (0: it couldn't start). For the model servers every agent shares:
// an asker's cap isn't theirs, and they outlive it. `apart:<cap>` (kit 2.78.3) also puts it in the servers' job, one
// for the PC (Local\kit-apart-pace), with a hard cap on the processor (the manor's ceiling, 85%): every server started
// apart shares it, so together they stay within it. The job ends nothing: each server holds a handle to it, so it and
// its name last while any server runs, and a server outlives the launcher. A server that can't join it (one that
// couldn't leave a job of another family) gets a job of its own with the same cap; and if neither takes, it runs as
// before.
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
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr fromProcess, IntPtr h, IntPtr toProcess, out IntPtr copy, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

    const int JobObjectExtendedLimitInformation = 9, JobObjectCpuRateControlInformation = 15;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100, JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
    const uint WAIT_OBJECT_0 = 0, WAIT_ABANDONED_0 = 0x80;
    /// <summary>How long a launcher waits for a turn before it runs its command without one: 20 minutes.</summary>
    public const uint TURN_WAIT_MS = 20 * 60 * 1000;
    /// <summary>The environment variable a launcher sets for its command, so a launcher inside it takes no turn.</summary>
    public const string TURN_HELD = "KIT_CHECKS_TURN";
    const uint CPU_RATE_ENABLE = 0x1, CPU_RATE_HARD_CAP = 0x4;
    const uint CREATE_SUSPENDED = 0x4, BELOW_NORMAL_PRIORITY_CLASS = 0x4000;
    const uint DETACHED_PROCESS = 0x8, CREATE_NEW_PROCESS_GROUP = 0x200, CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint INFINITE = 0xFFFFFFFF;
    const uint DUPLICATE_SAME_ACCESS = 0x2;

    /// <summary>The job every launcher on the PC shares (per sign-in session).</summary>
    public const string JobName = @"Local\kit-checks-pace";

    /// <summary>The job every model server started apart shares (per sign-in session), kit 2.78.3.</summary>
    public const string ApartJobName = "kit-apart-pace";

    // The servers' job's name: KIT_APART_JOB_NAME, so a test's servers are in a job of their own, never the PC's real one.
    static string ApartJob()
    {
        string n = Environment.GetEnvironmentVariable("KIT_APART_JOB_NAME");
        return @"Local\" + (string.IsNullOrEmpty(n) || n.IndexOf('\\') >= 0 ? ApartJobName : n);
    }

    /// <summary>`apart` (no cap: no job) or `apart:<cap>`; -1 when the word is neither.</summary>
    public static int ApartCap(string word)
    {
        if (word == "apart") return 0;
        int cap;
        return word.StartsWith("apart:") && int.TryParse(word.Substring(6), out cap) && cap >= 0 ? cap : -1;
    }

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
        int apartCap = args.Length >= 2 ? ApartCap(args[0]) : -1;
        if (apartCap >= 0 && line.Length > 0) return Apart(line, apartCap);
        if (args.Length < 2 || !ParseLimits(args[0], out limits) || line.Length == 0)
        {
            Console.Error.WriteLine("usage: checks-pace <cap in hundredths of a percent>[,<MB per process>,<MB for the job>,<runs at once>] <command line>");
            return 2;
        }
        // Ctrl+C goes to the command, which shares this console: the launcher waits for it to end.
        SetConsoleCtrlHandler(IntPtr.Zero, true);
        string runs = TakesTurn(limits.AtOnce) ? RunsFile() : null;
        Say(runs, "waiting", -1);
        int slot;
        IntPtr turn = TakeTurn(limits.AtOnce, out slot);
        Say(runs, turn != IntPtr.Zero ? "turn" : "running", turn != IntPtr.Zero ? slot : -1);
        Environment.SetEnvironmentVariable(TURN_HELD, "1");
        // The programs it starts take no turn, so say nothing of their own.
        Environment.SetEnvironmentVariable(RUNS, null);
        try { return Run(line, limits); }
        finally
        {
            if (turn != IntPtr.Zero) { ReleaseMutex(turn); CloseHandle(turn); }
            if (runs != null) try { System.IO.File.Delete(runs); } catch { }
        }
    }

    /// <summary>The folder a launcher says where it stands in (work-status.ts's checksRunsDir); none unset.</summary>
    public const string RUNS = "KIT_CHECKS_RUNS";

    // Whether this launcher takes part in the PC's turns: asked for, and not inside another launcher's run.
    static bool TakesTurn(int atOnce)
    {
        return atOnce > 0 && string.IsNullOrEmpty(Environment.GetEnvironmentVariable(TURN_HELD));
    }

    // This launcher's file in KIT_CHECKS_RUNS's folder, or null when that isn't set or can't be made.
    static string RunsFile()
    {
        string dir = Environment.GetEnvironmentVariable(RUNS);
        if (string.IsNullOrEmpty(dir)) return null;
        try
        {
            System.IO.Directory.CreateDirectory(dir);
            return System.IO.Path.Combine(dir, System.Diagnostics.Process.GetCurrentProcess().Id + ".run");
        }
        catch { return null; }
    }

    // Where this launcher stands, in its file: the state, the turn (-1 for none) and since when, then who started it.
    static void Say(string file, string state, int slot)
    {
        if (file == null) return;
        string who = (Environment.GetEnvironmentVariable("KIT_CHECKS_WHO") ?? "").Replace('\r', ' ').Replace('\n', ' ');
        if (who.Length > 300) who = who.Substring(0, 300);
        try { System.IO.File.WriteAllText(file, state + " " + slot + " " + DateTime.UtcNow.ToString("o") + "\n" + who + "\n"); } catch { }
    }

    // One of the PC's turns for check runs, or zero for none: none asked, one already held by the launcher this runs
    // inside, or none had within TURN_WAIT_MS. A mutex left by a launcher that was stopped comes free as abandoned.
    // `slot`: which of them, or -1.
    static IntPtr TakeTurn(int atOnce, out int slot)
    {
        slot = -1;
        if (!TakesTurn(atOnce)) return IntPtr.Zero;
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
        slot = held;
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
        // Out of the agent's own gentle job first (gentle.cs lets a program leave it), so the checks pace's cap is the one
        // that holds the command, not the agent's tighter one as well (kit 2.74.6): the Steward's checks were held to its
        // gentle cap, two processors' worth, whatever Manor's checksPace said. If Windows refuses (a job that doesn't let
        // it leave), in the jobs it is in, as before.
        uint flags = CREATE_SUSPENDED | BELOW_NORMAL_PRIORITY_CLASS;
        if (!CreateProcess(null, new System.Text.StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, flags | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, null, ref si, out pi)
            && !CreateProcess(null, new System.Text.StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi))
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

    // Starts `line` detached and out of the jobs that let it leave (CREATE_BREAKAWAY_FROM_JOB: it leaves each job up to
    // the first that doesn't allow it, and stays in that one); if Windows refuses, as the launcher's own child. With a
    // cap, it starts suspended and runs once it is in the servers' job (Contained). Its standard output and error are the
    // launcher's standard error. The exit code is its process id, 0 when it couldn't start.
    static int Apart(string line, int cap)
    {
        IntPtr err = GetStdHandle(-12);
        var si = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), dwFlags = STARTF_USESTDHANDLES, hStdInput = IntPtr.Zero, hStdOutput = err, hStdError = err };
        ProcessInformation pi;
        uint flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | (cap > 0 ? CREATE_SUSPENDED : 0);
        bool ok = CreateProcess(null, new System.Text.StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, flags | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, null, ref si, out pi)
            || CreateProcess(null, new System.Text.StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi);
        if (!ok)
        {
            Console.Error.WriteLine("checks-pace: couldn't start " + line + " (Windows error " + Marshal.GetLastWin32Error() + ")");
            return 0;
        }
        if (cap > 0)
        {
            // The PC's servers' job, else one of its own; if neither takes, it runs as it is: the cap never stops a server.
            if (!Contained(CreateJobObject(IntPtr.Zero, ApartJob()), pi.hProcess, cap)) Contained(CreateJobObject(IntPtr.Zero, null), pi.hProcess, cap);
            ResumeThread(pi.hThread);
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return pi.dwProcessId;
    }

    // The servers' job with its cap set (again, if another launcher made it), the process in it, and a handle to it
    // copied into the process, so the job and its name outlive this launcher for as long as any server in it runs. No
    // limit ends anything: a server lives until it is stopped. False, and the handle closed, when it couldn't be.
    static bool Contained(IntPtr job, IntPtr p, int cap)
    {
        if (job == IntPtr.Zero) return false;
        var rate = new CpuRateControl { ControlFlags = CPU_RATE_ENABLE | CPU_RATE_HARD_CAP, CpuRate = (uint)Math.Max(100, Math.Min(10000, cap)) };
        SetInformationJobObject(job, JobObjectCpuRateControlInformation, ref rate, Marshal.SizeOf(typeof(CpuRateControl)));
        IntPtr kept;
        bool ok = AssignProcessToJobObject(job, p) && DuplicateHandle(GetCurrentProcess(), job, p, out kept, 0, false, DUPLICATE_SAME_ACCESS);
        CloseHandle(job);
        return ok;
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
