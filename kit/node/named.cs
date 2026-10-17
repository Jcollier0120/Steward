// The agent's name in Task Manager (named.ts): a small launcher that starts the agent's page in a job of the agent's own
// and waits for it. Task Manager's Processes tab shows a program by its file description, and puts what it starts under
// it, so a page started through it shows as "Smith (3)" with its PowerShell worker and its git inside, where node.exe
// alone shows as "Node.js JavaScript Runtime", one like every other agent's. Compiled once per agent (named.ts), its name
// written into the title below, into the folder every agent's launchers share. Its own command line: the agent's id, a
// word, then the command line to run, as is.
//
// The job (Local\Castellan-<id>) holds everything the page starts, so a tool can find the agent's processes, and add up
// what they take, by its id. It ends nothing: what the page starts detached outlives it as it always has (a model
// server started without the apart launcher, an install's watcher, which must outlive the page it replaces). It lets a
// program leave it (CREATE_BREAKAWAY_FROM_JOB): the model servers every agent shares are started apart (apart.ts), and
// the checks pace takes its runs into its own job (checks-pace.cs). The gentle pace's job (gentle.cs) nests inside it.
// It sets no cap of its own: the pace does.
//
// The manor's ceiling (kit 2.78.7): before its own job, the page joins the job above every family's
// (Local\kit-manor-ceiling, KIT_CEILING its cap: the manor's ceiling, 85%; checks-pace.cs, which the check runs and
// model servers join too), so its own job nests inside it, and the agents, their checks and the servers together stay
// within it. So the page starts out of the jobs that let it leave (Task Scheduler's, which Manor runs in, and so every
// page it starts), as the check runs and the servers do. The ceiling is made only for a page in no job (a root, never
// inside the tree of whatever started the launcher); a page that couldn't leave one only joins it where Windows lets it.
// KIT_CEILING unset or 0 (Manor's own page): no ceiling, and the page starts in the launcher's jobs, as before.
//
// The page shares the launcher's console, the windowless one cmd's `start /b` gave it (service.ts's pageLaunch), so its
// git and gh share that too (console.ts), and its standard handles (serve.log). Ctrl+C goes to the page, which the
// launcher waits for. If the job can't be had, the page runs as it is: the name is never a reason not to start.
using System;
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("KIT_NAMED_TITLE")]
[assembly: AssemblyProduct("Castellan")]
[assembly: AssemblyDescription("Runs an agent of Castellan's: its page, and everything it starts.")]

public static class KitNamed
{
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
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr p, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref CpuRateControl info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr fromProcess, IntPtr h, IntPtr toProcess, out IntPtr copy, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

    [StructLayout(LayoutKind.Sequential)]
    struct CpuRateControl { public uint ControlFlags; public uint CpuRate; }

    const int JobObjectExtendedLimitInformation = 9, JobObjectCpuRateControlInformation = 15;
    const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800;
    const uint JOB_OBJECT_ALL_ACCESS = 0x1F001F, CPU_RATE_ENABLE = 0x1, CPU_RATE_HARD_CAP = 0x4, DUPLICATE_SAME_ACCESS = 0x2;
    const uint CREATE_SUSPENDED = 0x4, CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint INFINITE = 0xFFFFFFFF;

    /// <summary>The agent's job: one per agent and sign-in session, so a tool can find it by the agent's id.</summary>
    public static string JobName(string id) { return @"Local\Castellan-" + id; }

    public static int Main(string[] args)
    {
        string line = Rest(Marshal.PtrToStringUni(GetCommandLineW()));
        if (args.Length < 2 || line.Length == 0 || !IsId(args[0]))
        {
            Console.Error.WriteLine("usage: <agent>.exe <agent id> <command line>");
            return 2;
        }
        // Ctrl+C goes to the page, which shares this console: the launcher waits for it to end.
        SetConsoleCtrlHandler(IntPtr.Zero, true);
        var si = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), dwFlags = STARTF_USESTDHANDLES, hStdInput = GetStdHandle(-10), hStdOutput = GetStdHandle(-11), hStdError = GetStdHandle(-12) };
        ProcessInformation pi;
        // With the manor's ceiling, out of the jobs that let it leave first (Task Scheduler's, which Manor and so every page
        // it starts runs in), so the page is in no job and can join the ceiling; where Windows refuses, in the jobs it is
        // in, as before.
        bool ceiling = CeilingCap() > 0;
        if (!(ceiling && CreateProcess(null, new System.Text.StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, null, ref si, out pi))
            && !CreateProcess(null, new System.Text.StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, null, ref si, out pi))
        {
            int err = Marshal.GetLastWin32Error();
            Console.Error.WriteLine("named: couldn't start " + line + " (Windows error " + err + ")");
            return err == 2 || err == 3 ? 127 : 126;
        }
        // The manor's ceiling first, while the page is still suspended, so its own job nests inside it.
        InCeiling(pi.hProcess);
        IntPtr job = Joined(CreateJobObject(IntPtr.Zero, JobName(args[0])), pi.hProcess);
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        if (!GetExitCodeProcess(pi.hProcess, out code)) code = 1;
        CloseHandle(pi.hProcess);
        if (job != IntPtr.Zero) CloseHandle(job);
        return (int)code;
    }

    // The job with its limits set (a program may leave it; nothing in it is ended with it) and the process in it; zero,
    // and the handle closed, when it couldn't be (a job the launcher is in that won't take another inside it).
    static IntPtr Joined(IntPtr job, IntPtr p)
    {
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var limit = new ExtendedLimit();
        limit.Basic.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(ExtendedLimit)));
        if (AssignProcessToJobObject(job, p)) return job;
        CloseHandle(job);
        return IntPtr.Zero;
    }

    // The page in the manor's ceiling (checks-pace.cs InCeiling, the same rule): true once it is. Made only for a page in
    // no job; a test's own ceiling (KIT_CEILING_JOB_NAME) may be made anywhere. Never stops the page.
    static int CeilingCap()
    {
        int cap;
        return int.TryParse(Environment.GetEnvironmentVariable("KIT_CEILING"), out cap) && cap > 0 ? Math.Min(cap, 10000) : 0;
    }

    static bool InCeiling(IntPtr p)
    {
        int cap = CeilingCap();
        if (cap <= 0) return false;
        string n = Environment.GetEnvironmentVariable("KIT_CEILING_JOB_NAME");
        bool tests = !string.IsNullOrEmpty(n) && n.IndexOf('\\') < 0, inAny;
        string name = @"Local\" + (tests ? n : "kit-manor-ceiling");
        if (!IsProcessInJob(p, IntPtr.Zero, out inAny)) return false;
        IntPtr job = inAny && !tests ? OpenJobObject(JOB_OBJECT_ALL_ACCESS, false, name) : CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) return false;
        try
        {
            bool already;
            if (IsProcessInJob(p, job, out already) && already) return true;
            var limit = new ExtendedLimit();
            limit.Basic.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(ExtendedLimit)));
            var rate = new CpuRateControl { ControlFlags = CPU_RATE_ENABLE | CPU_RATE_HARD_CAP, CpuRate = (uint)Math.Max(100, Math.Min(10000, cap)) };
            SetInformationJobObject(job, JobObjectCpuRateControlInformation, ref rate, Marshal.SizeOf(typeof(CpuRateControl)));
            IntPtr kept;
            return AssignProcessToJobObject(job, p) && DuplicateHandle(GetCurrentProcess(), job, p, out kept, 0, false, DUPLICATE_SAME_ACCESS);
        }
        finally { CloseHandle(job); }
    }

    /// <summary>An agent's id: letters, digits and hyphens, as APP.id is.</summary>
    public static bool IsId(string s)
    {
        if (s.Length == 0 || s.Length > 64) return false;
        foreach (char c in s) if (!(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-')) return false;
        return true;
    }

    /// <summary>
    /// The command line after the launcher's own path and the agent's id, exactly as given: the launcher's path quoted or
    /// not (Windows' rule for a program's name: up to the next quote, else the next space), the id a word without quotes.
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
