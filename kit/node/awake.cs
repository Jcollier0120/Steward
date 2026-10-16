// Keeps Windows from sleeping on its own while an agent's work runs (awake.ts, kit 2.74.8). Compiled once to an exe that
// every agent on the PC shares, as checks-pace.cs is. The agent starts it when work begins and closes its input when the
// work ends. It asks Windows to keep the system working (ES_CONTINUOUS | ES_SYSTEM_REQUIRED, from its main thread) until
// its input closes, or the process named on its command line (the agent) ends, then lets go and exits. Windows ends the
// request with the thread anyway, so the request never outlasts the helper.
//
// Idle sleep only: not the display (no ES_DISPLAY_REQUIRED), and not away mode (no ES_AWAYMODE_REQUIRED). A sleep the
// person chooses (Start's Sleep, the power button, closing the lid) still happens: Windows doesn't block those for a
// system-required request. `powercfg /requests` lists the helper while it holds.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class KitAwake
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint SetThreadExecutionState(uint flags);

    const uint ES_CONTINUOUS = 0x80000000;
    const uint ES_SYSTEM_REQUIRED = 0x00000001;

    public static int Main(string[] args)
    {
        // `--for <seconds>`: the wake task's (wake.ts), run by Task Scheduler with no agent and no input. It holds the woken
        // PC that long at most, then lets go; the agent ends the task sooner once its work is done (endWakeTask).
        int seconds;
        if (args.Length > 1 && args[0] == "--for" && int.TryParse(args[1], out seconds) && seconds > 0)
        {
            if (SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) == 0) return 2;
            Thread.Sleep(TimeSpan.FromSeconds(seconds));
            SetThreadExecutionState(ES_CONTINUOUS);
            return 0;
        }
        Process owner = null;
        int pid;
        if (args.Length > 0 && int.TryParse(args[0], out pid) && pid > 0)
        {
            try { owner = Process.GetProcessById(pid); } catch { return 0; }
        }
        if (SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) == 0) return 2;
        // Its input read on a thread of its own, so the main thread, which holds the request, is free to watch the owner.
        var reader = new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } });
        reader.IsBackground = true;
        reader.Start();
        while (!reader.Join(1000))
        {
            try { if (owner != null && owner.HasExited) break; } catch { break; }
        }
        SetThreadExecutionState(ES_CONTINUOUS);
        return 0;
    }
}
