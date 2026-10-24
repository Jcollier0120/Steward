// Castellan's catalogs in Windows' catalog database (catalogs.ts, kit 2.108.0): a catalog is a list of files' hashes,
// signed, and a file whose hash is in one installed in the database counts as signed by the catalog's signer, wherever
// the file is. So a server whose maker doesn't sign it (FastFlowLM's NPU build, whose terms let it be passed on only
// unmodified) runs under Smart App Control as the maker built it, from the maker's own download, once Castellan's
// catalog of its files is installed. Installing and removing one takes an administrator; this runs elevated, once for
// every change, through Windows' administrator prompt.
//
// Its command line is steps, run in order: `add <file.cat>` installs a catalog under its own file name, `remove
// <name.cat>` removes the one installed under that name (one that isn't there is gone already), and `load <file>
// [<seconds>]` loads a library as Windows would to run it (its references left unresolved, so none of its code runs)
// and says whether Windows blocked it, trying again until it loads or the seconds are up (the NPU check's catalog test:
// Windows takes a newly installed catalog into account within moments). `--log <file>` first writes each step's line
// there too: an elevated run's own window can't print to the one that asked for it. Each step says one line: "added
// <name>", "removed <name>", "not there <name>", "loaded <file>", "blocked <file> <error>" (577, 1260 or 4550 to 4580:
// Windows' application control refused it), "failed <step> <name> <error>". It exits 0 when every add and remove was done,
// else the first failed one's error (5: not elevated); a load never changes it. Compiled once to an exe every agent
// shares, signed (prebuilt.ts): unsigned, Smart App Control would block it too.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class KitCatalog
{
    [DllImport("wintrust.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptCATAdminAcquireContext2(out IntPtr admin, ref Guid subsystem, string hashAlgorithm, IntPtr strongHashPolicy, uint flags);
    [DllImport("wintrust.dll", SetLastError = true)] static extern bool CryptCATAdminReleaseContext(IntPtr admin, uint flags);
    [DllImport("wintrust.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CryptCATAdminAddCatalog(IntPtr admin, string catalogFile, string selectBaseName, uint flags);
    [DllImport("wintrust.dll", SetLastError = true)] static extern bool CryptCATAdminReleaseCatalogContext(IntPtr admin, IntPtr info, uint flags);
    [DllImport("wintrust.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptCATAdminRemoveCatalog(IntPtr admin, string catalogFile, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeLibrary(IntPtr module);

    // DRIVER_ACTION_VERIFY: the database of the system's components and drivers, the one code integrity reads.
    static Guid DriverActionVerify = new Guid("F750E6C3-38EE-11D1-85E5-00C04FC295EE");
    // DONT_RESOLVE_DLL_REFERENCES: mapped to run, so Windows checks it, but neither its DllMain nor its imports run.
    const uint DONT_RESOLVE_DLL_REFERENCES = 0x1;
    const int ERROR_FILE_NOT_FOUND = 2, ERROR_INVALID_PARAMETER = 87, ERROR_NOT_FOUND = 1168;

    static string logFile;

    static void Say(string line)
    {
        Console.WriteLine(line);
        if (logFile == null) return;
        try { File.AppendAllText(logFile, line + Environment.NewLine, new UTF8Encoding(false)); } catch { }
    }

    static int Add(IntPtr admin, string file)
    {
        string name = Path.GetFileName(file);
        if (!File.Exists(file)) { Say("failed add " + name + " " + ERROR_FILE_NOT_FOUND); return ERROR_FILE_NOT_FOUND; }
        IntPtr info = CryptCATAdminAddCatalog(admin, Path.GetFullPath(file), name, 0);
        if (info == IntPtr.Zero) { int e = Marshal.GetLastWin32Error(); Say("failed add " + name + " " + e); return e == 0 ? 1 : e; }
        CryptCATAdminReleaseCatalogContext(admin, info, 0);
        Say("added " + name);
        return 0;
    }

    static int Remove(IntPtr admin, string name)
    {
        if (CryptCATAdminRemoveCatalog(admin, name, 0)) { Say("removed " + name); return 0; }
        int e = Marshal.GetLastWin32Error();
        if (e == ERROR_FILE_NOT_FOUND || e == ERROR_NOT_FOUND) { Say("not there " + name); return 0; }
        Say("failed remove " + name + " " + e);
        return e == 0 ? 1 : e;
    }

    // Windows' application control refusing a file: 577 (its signature), 1260 (a policy), 4550 to 4580 (code integrity's
    // policy and Smart App Control's reputation answers). Anything else (126, 193) is the file, not a block.
    static bool Blocked(int e) { return e == 577 || e == 1260 || (e >= 4550 && e <= 4580); }

    static void Load(string file, double seconds)
    {
        if (!File.Exists(file)) { Say("failed load " + file + " " + ERROR_FILE_NOT_FOUND); return; }
        DateTime until = DateTime.UtcNow.AddSeconds(seconds);
        int e;
        while (true)
        {
            IntPtr m = LoadLibraryExW(Path.GetFullPath(file), IntPtr.Zero, DONT_RESOLVE_DLL_REFERENCES);
            if (m != IntPtr.Zero) { FreeLibrary(m); Say("loaded " + file); return; }
            e = Marshal.GetLastWin32Error();
            if (!Blocked(e) || DateTime.UtcNow >= until) break;
            Thread.Sleep(250);
        }
        Say((Blocked(e) ? "blocked " : "failed load ") + file + " " + e);
    }

    public static int Main(string[] args)
    {
        int i = 0;
        if (args.Length > 1 && args[0] == "--log") { logFile = args[1]; i = 2; }
        IntPtr admin = IntPtr.Zero;
        int first = 0;
        try
        {
            for (; i < args.Length; i++)
            {
                string step = args[i];
                if (i + 1 >= args.Length) { Say("failed " + step + " (nothing named) " + ERROR_INVALID_PARAMETER); return ERROR_INVALID_PARAMETER; }
                string what = args[++i];
                if (step == "load")
                {
                    double s = 0;
                    if (i + 1 < args.Length && double.TryParse(args[i + 1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out s)) i++;
                    Load(what, s);
                    continue;
                }
                if (step != "add" && step != "remove") { Say("failed " + step + " (not a step) " + ERROR_INVALID_PARAMETER); return ERROR_INVALID_PARAMETER; }
                if (admin == IntPtr.Zero && !CryptCATAdminAcquireContext2(out admin, ref DriverActionVerify, "SHA256", IntPtr.Zero, 0))
                {
                    int e = Marshal.GetLastWin32Error();
                    admin = IntPtr.Zero;
                    Say("failed " + step + " " + Path.GetFileName(what) + " " + e);
                    if (first == 0) first = e == 0 ? 1 : e;
                    continue;
                }
                int r = step == "add" ? Add(admin, what) : Remove(admin, what);
                if (r != 0 && first == 0) first = r;
            }
        }
        finally
        {
            if (admin != IntPtr.Zero) CryptCATAdminReleaseContext(admin, 0);
        }
        return first;
    }
}
