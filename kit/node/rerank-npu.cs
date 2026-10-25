// AMD's NPU's reranker (rerank-npu.ts): Qwen3-Reranker-0.6B on the NPU through ONNX Runtime and AMD's VitisAI plugin
// (Windows ML's, as ocr-npu.cs loads it), behind llama.cpp's reranking API, so the staff ask it as they ask a card's
// llama-server --reranking. A console program the kit compiles and signs like its other helpers (prebuilt.ts); C# 5,
// as Windows PowerShell's Add-Type compiles it.
//
//   rerank-npu.exe --dir <model folder> --ort <folder of onnxruntime.dll> [--vitisai <folder of Windows ML's DLL> --cache <folder>]
//                  --serve --host 127.0.0.1 --port <n> [--alias <model>]    the server (on the NPU, its graph compiled)
//                  --start                                                  the start's keys and values, on the processor
//                  --prepare                                                the NPU's graph compiled, then checked
//                  --compile                                                (--prepare's) the compile alone
//                  --status                                                 whether it's compiled for this NPU's driver
//                  --tokenize <file>                                        (a test) texts split by NUL, their tokens
//
// The model folder (rerank-npu-export.ts makes it) has rerank.json (the start's tokens, the static length, the check),
// vocab.txt, merges.txt and added.txt (Qwen's tokenizer), table.f32 (the embedding table, 151,669 x 1,024), weights.bin,
// start.onnx and, after --start, kv.f32 and model-640.onnx. Each document is scored on its own: the template's tokens
// after its constant start (which the graph holds), padded at the end to the graph's length, the score the sigmoid of
// the logit at the last real token (llama.cpp's relevance_score). One that doesn't fit is cut (Fit).
//
// --serve answers GET /v1/models, /models and /health, and POST /v1/rerank (and /rerank, /v1/reranking): {"query":..,
// "documents":[..],"top_n":n} -> {"model":..,"object":"list","usage":{..},"results":[{"index":i,"relevance_score":s},..]},
// the best first. Any other POST (a chat, as a caller's warm-up) gets an empty answer, as a reranking llama-server's.
// What it says goes to stderr, a line a request; stdout carries the program's own lines (--start, --prepare) alone.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace KitRerankNpu
{
    public sealed class OrtException : Exception
    {
        public OrtException(string message) : base(message) { }
    }

    /// <summary>ONNX Runtime's C API (onnxruntime_c_api.h, API version 27): the functions this program uses, as ocr-npu.cs has them.</summary>
    public sealed class Ort
    {
        const uint ApiVersion = 27;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true, BestFitMapping = false)]
        static extern IntPtr GetProcAddress(IntPtr module, string name);

        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetApiBaseFn();
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetApiFn(uint version);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetErrorMessageFn(IntPtr status);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void ReleaseFn(IntPtr p);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateEnvFn(int level, [MarshalAs(UnmanagedType.LPStr)] string logid, out IntPtr env);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateSessionOptionsFn(out IntPtr options);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr IntOptionFn(IntPtr options, int value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr ConfigEntryFn(IntPtr options, [MarshalAs(UnmanagedType.LPStr)] string key, [MarshalAs(UnmanagedType.LPStr)] string value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateSessionFn(IntPtr env, [MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr options, out IntPtr session);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateCpuMemoryInfoFn(int allocator, int memType, out IntPtr info);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateTensorFn(IntPtr info, IntPtr data, UIntPtr bytes, long[] shape, UIntPtr rank, int type, out IntPtr value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr RunFn(IntPtr session, IntPtr runOptions, IntPtr[] inputNames, IntPtr[] inputs, UIntPtr inputCount, IntPtr[] outputNames, UIntPtr outputCount, IntPtr[] outputs);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetDataFn(IntPtr value, out IntPtr data);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetTypeAndShapeFn(IntPtr value, out IntPtr info);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetDimensionsCountFn(IntPtr info, out UIntPtr count);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetDimensionsFn(IntPtr info, long[] dims, UIntPtr count);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr RegisterEpFn(IntPtr env, [MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string path);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetEpDevicesFn(IntPtr env, out IntPtr devices, out UIntPtr count);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr AppendEpFn(IntPtr options, IntPtr env, IntPtr[] devices, UIntPtr deviceCount, IntPtr[] keys, IntPtr[] values, UIntPtr optionCount);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr PointerOfFn(IntPtr p);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int IntOfFn(IntPtr p);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetNameFn(IntPtr session, UIntPtr index, IntPtr allocator, out IntPtr name);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetAllocatorFn(out IntPtr allocator);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr AllocatorFreeFn(IntPtr allocator, IntPtr p);

        readonly IntPtr api;
        readonly GetErrorMessageFn getErrorMessage;
        readonly ReleaseFn releaseStatus, releaseSession, releaseOptions, releaseValue, releaseTypeAndShape;
        readonly CreateSessionOptionsFn createSessionOptions;
        readonly IntOptionFn setIntraOpThreads, setOptimization;
        readonly ConfigEntryFn addConfigEntry;
        readonly CreateSessionFn createSession;
        readonly CreateTensorFn createTensor;
        readonly RunFn run;
        readonly GetDataFn getData;
        readonly GetTypeAndShapeFn getTypeAndShape;
        readonly GetDimensionsCountFn getDimensionsCount;
        readonly GetDimensionsFn getDimensions;
        readonly RegisterEpFn registerEp;
        readonly GetEpDevicesFn getEpDevices;
        readonly AppendEpFn appendEp;
        readonly PointerOfFn epDeviceEpName, epDeviceDevice;
        readonly IntOfFn hardwareType;
        readonly GetNameFn inputName, outputName;
        readonly AllocatorFreeFn allocatorFree;
        readonly IntPtr allocator, memoryInfo;
        public readonly IntPtr Env;
        public readonly string Version;
        readonly HashSet<string> registered = new HashSet<string>();

        T Fn<T>(int index) where T : class
        {
            return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(api, index * IntPtr.Size), typeof(T)) as T;
        }

        public Ort(string folder)
        {
            // Its own folder first for what it loads (onnxruntime_providers_shared.dll beside it).
            IntPtr lib = LoadLibraryExW(Path.Combine(folder, "onnxruntime.dll"), IntPtr.Zero, 0x00000008);
            if (lib == IntPtr.Zero) throw new OrtException("onnxruntime.dll didn't load from " + folder + " (error " + Marshal.GetLastWin32Error() + ")");
            IntPtr baseFn = GetProcAddress(lib, "OrtGetApiBase");
            if (baseFn == IntPtr.Zero) throw new OrtException("onnxruntime.dll has no OrtGetApiBase");
            IntPtr apiBase = ((GetApiBaseFn)Marshal.GetDelegateForFunctionPointer(baseFn, typeof(GetApiBaseFn)))();
            GetApiFn getApi = (GetApiFn)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(apiBase, 0), typeof(GetApiFn));
            PointerOfFn versionString = (PointerOfFn)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(apiBase, IntPtr.Size), typeof(PointerOfFn));
            Version = Marshal.PtrToStringAnsi(versionString(IntPtr.Zero));
            api = getApi(ApiVersion);
            if (api == IntPtr.Zero) throw new OrtException("ONNX Runtime " + Version + " doesn't offer API version " + ApiVersion);
            getErrorMessage = Fn<GetErrorMessageFn>(2);
            CreateEnvFn createEnv = Fn<CreateEnvFn>(3);
            createSession = Fn<CreateSessionFn>(7);
            run = Fn<RunFn>(9);
            createSessionOptions = Fn<CreateSessionOptionsFn>(10);
            setOptimization = Fn<IntOptionFn>(23);
            setIntraOpThreads = Fn<IntOptionFn>(24);
            inputName = Fn<GetNameFn>(36);
            outputName = Fn<GetNameFn>(37);
            createTensor = Fn<CreateTensorFn>(49);
            getData = Fn<GetDataFn>(51);
            getDimensionsCount = Fn<GetDimensionsCountFn>(61);
            getDimensions = Fn<GetDimensionsFn>(62);
            getTypeAndShape = Fn<GetTypeAndShapeFn>(65);
            CreateCpuMemoryInfoFn createCpuMemoryInfo = Fn<CreateCpuMemoryInfoFn>(69);
            allocatorFree = Fn<AllocatorFreeFn>(76);
            GetAllocatorFn getAllocator = Fn<GetAllocatorFn>(78);
            releaseStatus = Fn<ReleaseFn>(93);
            releaseSession = Fn<ReleaseFn>(95);
            releaseValue = Fn<ReleaseFn>(96);
            releaseTypeAndShape = Fn<ReleaseFn>(99);
            releaseOptions = Fn<ReleaseFn>(100);
            addConfigEntry = Fn<ConfigEntryFn>(130);
            registerEp = Fn<RegisterEpFn>(301);
            getEpDevices = Fn<GetEpDevicesFn>(303);
            appendEp = Fn<AppendEpFn>(304);
            hardwareType = Fn<IntOfFn>(307);
            epDeviceEpName = Fn<PointerOfFn>(312);
            epDeviceDevice = Fn<PointerOfFn>(316);
            IntPtr env;
            Check(createEnv(3, "kit-rerank", out env));
            Env = env;
            IntPtr info;
            Check(createCpuMemoryInfo(1, 0, out info));
            memoryInfo = info;
            IntPtr alloc;
            Check(getAllocator(out alloc));
            allocator = alloc;
        }

        public void Check(IntPtr status)
        {
            if (status == IntPtr.Zero) return;
            string message = Marshal.PtrToStringAnsi(getErrorMessage(status));
            releaseStatus(status);
            throw new OrtException(message);
        }

        /// <summary>A session's options: its own threads (0: one a core), which never spin while they wait (ocr-npu.cs' Options).</summary>
        public IntPtr Options(int threads)
        {
            IntPtr o;
            Check(createSessionOptions(out o));
            Check(setOptimization(o, 99));
            if (threads > 0) Check(setIntraOpThreads(o, threads));
            Config(o, "session.intra_op.allow_spinning", "0");
            return o;
        }

        public void Config(IntPtr options, string key, string value) { Check(addConfigEntry(options, key, value)); }
        public void ReleaseOptions(IntPtr options) { releaseOptions(options); }

        public void Register(string name, string library)
        {
            if (registered.Contains(name)) return;
            Check(registerEp(Env, name, library));
            registered.Add(name);
        }

        /// <summary>The devices an execution provider offers of a kind (0 processor, 1 graphics card, 2 NPU).</summary>
        public List<IntPtr> Devices(string epName, int type)
        {
            IntPtr devices;
            UIntPtr count;
            Check(getEpDevices(Env, out devices, out count));
            List<IntPtr> found = new List<IntPtr>();
            for (int i = 0; i < (int)count; i++)
            {
                IntPtr d = Marshal.ReadIntPtr(devices, i * IntPtr.Size);
                if (Marshal.PtrToStringAnsi(epDeviceEpName(d)) == epName && hardwareType(epDeviceDevice(d)) == type) found.Add(d);
            }
            return found;
        }

        public void Append(IntPtr options, List<IntPtr> devices, IDictionary<string, string> settings)
        {
            List<IntPtr> strings = new List<IntPtr>();
            try
            {
                IntPtr[] keys = new IntPtr[settings.Count], values = new IntPtr[settings.Count];
                int k = 0;
                foreach (KeyValuePair<string, string> kv in settings)
                {
                    keys[k] = Marshal.StringToHGlobalAnsi(kv.Key);
                    values[k] = Marshal.StringToHGlobalAnsi(kv.Value);
                    strings.Add(keys[k]);
                    strings.Add(values[k]);
                    k++;
                }
                Check(appendEp(options, Env, devices.ToArray(), (UIntPtr)devices.Count, keys, values, (UIntPtr)settings.Count));
            }
            finally
            {
                foreach (IntPtr s in strings) Marshal.FreeHGlobal(s);
            }
        }

        public Session Open(string model, IntPtr options)
        {
            IntPtr s;
            Check(createSession(Env, model, options, out s));
            return new Session(this, s);
        }

        public sealed class Session : IDisposable
        {
            readonly Ort ort;
            IntPtr handle;
            readonly IntPtr input, output;

            internal Session(Ort ort, IntPtr handle)
            {
                this.ort = ort;
                this.handle = handle;
                input = Name(ort.inputName, 0);
                output = Name(ort.outputName, 0);
            }

            IntPtr Name(GetNameFn fn, int index)
            {
                IntPtr p;
                ort.Check(fn(handle, (UIntPtr)index, ort.allocator, out p));
                string s = Marshal.PtrToStringAnsi(p);
                ort.Check(ort.allocatorFree(ort.allocator, p));
                return Marshal.StringToHGlobalAnsi(s);
            }

            /// <summary>One float input in, the first output out.</summary>
            public float[] Run(float[] data, long[] shape)
            {
                GCHandle pin = GCHandle.Alloc(data, GCHandleType.Pinned);
                IntPtr value = IntPtr.Zero;
                IntPtr[] outputs = new IntPtr[1];
                try
                {
                    ort.Check(ort.createTensor(ort.memoryInfo, pin.AddrOfPinnedObject(), (UIntPtr)(data.Length * 4), shape, (UIntPtr)shape.Length, 1, out value));
                    ort.Check(ort.run(handle, IntPtr.Zero, new IntPtr[] { input }, new IntPtr[] { value }, (UIntPtr)1, new IntPtr[] { output }, (UIntPtr)1, outputs));
                    IntPtr info;
                    ort.Check(ort.getTypeAndShape(outputs[0], out info));
                    long n = 1;
                    try
                    {
                        UIntPtr rank;
                        ort.Check(ort.getDimensionsCount(info, out rank));
                        long[] dims = new long[(int)rank];
                        ort.Check(ort.getDimensions(info, dims, rank));
                        foreach (long d in dims) n *= d;
                    }
                    finally { ort.releaseTypeAndShape(info); }
                    IntPtr p;
                    ort.Check(ort.getData(outputs[0], out p));
                    float[] result = new float[n];
                    Marshal.Copy(p, result, 0, (int)n);
                    return result;
                }
                finally
                {
                    if (value != IntPtr.Zero) ort.releaseValue(value);
                    if (outputs[0] != IntPtr.Zero) ort.releaseValue(outputs[0]);
                    pin.Free();
                }
            }

            public void Dispose()
            {
                if (handle == IntPtr.Zero) return;
                ort.releaseSession(handle);
                handle = IntPtr.Zero;
                Marshal.FreeHGlobal(input);
                Marshal.FreeHGlobal(output);
            }
        }
    }

    /// <summary>
    /// Windows ML's catalog of NPU plugins (ocr-npu.cs' WindowsMl, which has the whole story): the plugin Windows has for
    /// AMD's NPU, and the junction to its folder its compiler needs.
    /// </summary>
    public static class WindowsMl
    {
        public const string Dll = "Microsoft.Windows.AI.MachineLearning.dll";

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true, BestFitMapping = false)]
        static extern IntPtr GetProcAddress(IntPtr module, string name);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool DeviceIoControl(Microsoft.Win32.SafeHandles.SafeFileHandle h, uint code, byte[] input, int inputSize, [Out] byte[] output, int outputSize, out int returned, IntPtr overlapped);

        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int CatalogCreateFn(out IntPtr catalog);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void CatalogReleaseFn(IntPtr catalog);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int FindProviderFn(IntPtr catalog, byte[] name, IntPtr version, out IntPtr provider);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int ReadyStateFn(IntPtr provider, out int state);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int EnsureReadyFn(IntPtr provider);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int PathSizeFn(IntPtr provider, out UIntPtr size);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int PathFn(IntPtr provider, UIntPtr size, [Out] byte[] buffer, out UIntPtr used);

        static IntPtr lib;

        static T Export<T>(string dll, string name) where T : class
        {
            if (lib == IntPtr.Zero)
            {
                lib = LoadLibraryExW(dll, IntPtr.Zero, 0x00000008);
                if (lib == IntPtr.Zero) throw new OrtException("Windows ML's " + Dll + " didn't load (error " + Marshal.GetLastWin32Error() + ")");
            }
            IntPtr f = GetProcAddress(lib, name);
            if (f == IntPtr.Zero) throw new OrtException("Windows ML's " + Dll + " has no " + name);
            return Marshal.GetDelegateForFunctionPointer(f, typeof(T)) as T;
        }

        static void Check(int hr, string call)
        {
            if (hr < 0) throw new OrtException("Windows ML's " + call + " failed (0x" + hr.ToString("X8", CultureInfo.InvariantCulture) + ")");
        }

        /// <summary>Windows' build: its own version check would say 9200 to a program without Windows 10 in its manifest.</summary>
        public static int Build()
        {
            using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
            {
                int b;
                return k != null && int.TryParse(k.GetValue("CurrentBuildNumber") as string, NumberStyles.Integer, CultureInfo.InvariantCulture, out b) ? b : 0;
            }
        }

        /// <summary>The plugin DLL Windows has for <paramref name="ep"/>, installed by Windows first when it isn't on the PC yet.</summary>
        public static string Plugin(string dll, string ep, string what)
        {
            if (Build() < 26100) throw new OrtException(what + " comes through Windows ML, which needs Windows 11 24H2 or later.");
            if (!File.Exists(dll)) throw new OrtException(what + " needs Windows ML's " + Dll + ", not fetched yet.");
            CatalogCreateFn create = Export<CatalogCreateFn>(dll, "WinMLEpCatalogCreate");
            CatalogReleaseFn release = Export<CatalogReleaseFn>(dll, "WinMLEpCatalogRelease");
            FindProviderFn find = Export<FindProviderFn>(dll, "WinMLEpCatalogFindProvider");
            ReadyStateFn state = Export<ReadyStateFn>(dll, "WinMLEpGetReadyState");
            EnsureReadyFn ensure = Export<EnsureReadyFn>(dll, "WinMLEpEnsureReady");
            PathSizeFn pathSize = Export<PathSizeFn>(dll, "WinMLEpGetLibraryPathSize");
            PathFn path = Export<PathFn>(dll, "WinMLEpGetLibraryPath");
            IntPtr catalog;
            Check(create(out catalog), "WinMLEpCatalogCreate");
            try
            {
                IntPtr p;
                if (find(catalog, Encoding.UTF8.GetBytes(ep + "\0"), IntPtr.Zero, out p) < 0 || p == IntPtr.Zero)
                    throw new OrtException("Windows offers no " + what + " for this PC: its NPU driver may be missing or too old.");
                int s;
                Check(state(p, out s), "WinMLEpGetReadyState");
                if (s == 2) throw new OrtException("Windows offers no " + what + " for this PC: its NPU driver may be missing or too old.");
                Check(ensure(p), "WinMLEpEnsureReady");
                UIntPtr n, used;
                Check(pathSize(p, out n), "WinMLEpGetLibraryPathSize");
                byte[] buf = new byte[(int)n];
                Check(path(p, n, buf, out used), "WinMLEpGetLibraryPath");
                string found = Encoding.UTF8.GetString(buf).TrimEnd('\0');
                if (found.Length == 0) throw new OrtException("Windows ML didn't say where " + what + " is.");
                return found;
            }
            finally { release(catalog); }
        }

        /// <summary>
        /// <paramref name="dll"/> through a junction at <paramref name="link"/> to its folder: from its own folder under
        /// WindowsApps AMD's compiler can't open itself (found in Heiward). The path as it was when no junction can be made.
        /// </summary>
        public static string Through(string dll, string link)
        {
            string target = Path.GetDirectoryName(dll), through = Path.Combine(link, Path.GetFileName(dll));
            try
            {
                if (Directory.Exists(link))
                {
                    string now = (File.GetAttributes(link) & FileAttributes.ReparsePoint) != 0 ? Target(link) : null;
                    if (now != null && string.Equals(now.TrimEnd('\\'), target.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return through;
                    Directory.Delete(link, false);
                }
                Directory.CreateDirectory(link);
                MountPoint(link, target);
                return through;
            }
            catch (Exception e)
            {
                if (!(e is IOException || e is UnauthorizedAccessException || e is System.ComponentModel.Win32Exception)) throw;
                return dll;
            }
        }

        const uint MountPointTag = 0xA0000003, OpenExisting = 3, BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;

        static Microsoft.Win32.SafeHandles.SafeFileHandle Open(string folder, uint access)
        {
            Microsoft.Win32.SafeHandles.SafeFileHandle h = CreateFileW(folder, access, 7, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
            if (h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return h;
        }

        static string Target(string link)
        {
            byte[] buf = new byte[16 * 1024];
            int got;
            using (Microsoft.Win32.SafeHandles.SafeFileHandle h = Open(link, 0x80000000))
                if (!DeviceIoControl(h, 0x000900A8, null, 0, buf, buf.Length, out got, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (BitConverter.ToUInt32(buf, 0) != MountPointTag) return null;
            int at = BitConverter.ToUInt16(buf, 12), length = BitConverter.ToUInt16(buf, 14);
            if (length > 0) return Encoding.Unicode.GetString(buf, 16 + at, length);
            string nt = Encoding.Unicode.GetString(buf, 16 + BitConverter.ToUInt16(buf, 8), BitConverter.ToUInt16(buf, 10));
            return nt.StartsWith(@"\??\", StringComparison.Ordinal) ? nt.Substring(4) : nt;
        }

        static void MountPoint(string link, string target)
        {
            byte[] nt = Encoding.Unicode.GetBytes(@"\??\" + target), shown = Encoding.Unicode.GetBytes(target);
            int names = nt.Length + 2 + shown.Length + 2;
            byte[] buf = new byte[16 + names];
            BitConverter.GetBytes(MountPointTag).CopyTo(buf, 0);
            BitConverter.GetBytes((ushort)(8 + names)).CopyTo(buf, 4);
            BitConverter.GetBytes((ushort)nt.Length).CopyTo(buf, 10);
            BitConverter.GetBytes((ushort)(nt.Length + 2)).CopyTo(buf, 12);
            BitConverter.GetBytes((ushort)shown.Length).CopyTo(buf, 14);
            nt.CopyTo(buf, 16);
            shown.CopyTo(buf, 16 + nt.Length + 2);
            int got;
            using (Microsoft.Win32.SafeHandles.SafeFileHandle h = Open(link, 0x40000000))
                if (!DeviceIoControl(h, 0x000900A4, buf, buf.Length, null, 0, out got, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    /// <summary>A folder deleted with all in it, however deep (ocr-npu.cs' Tree: AMD's compiler leaves paths past 260 characters).</summary>
    public static class Tree
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct FindData
        {
            public uint Attributes, Created0, Created1, Accessed0, Accessed1, Written0, Written1, SizeHigh, SizeLow, Reserved0, Reserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string ShortName;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr FindFirstFileW(string name, out FindData data);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool FindNextFileW(IntPtr h, out FindData data);

        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool FindClose(IntPtr h);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool DeleteFileW(string name);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool RemoveDirectoryW(string name);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetFileAttributesW(string name, uint attributes);

        const uint Folder = 0x10, ReadOnly = 0x1, Reparse = 0x400, Normal = 0x80;

        public static bool Delete(string folder)
        {
            if (!Directory.Exists(folder)) return true;
            Remove(@"\\?\" + Path.GetFullPath(folder).TrimEnd('\\'));
            return !Directory.Exists(folder);
        }

        static void Remove(string dir)
        {
            FindData d;
            IntPtr h = FindFirstFileW(dir + @"\*", out d);
            if (h != new IntPtr(-1))
            {
                try
                {
                    do
                    {
                        if (d.Name == "." || d.Name == "..") continue;
                        string p = dir + "\\" + d.Name;
                        if ((d.Attributes & ReadOnly) != 0) SetFileAttributesW(p, (d.Attributes & Folder) != 0 ? Folder : Normal);
                        if ((d.Attributes & Folder) == 0) DeleteFileW(p);
                        else if ((d.Attributes & Reparse) != 0) RemoveDirectoryW(p);
                        else Remove(p);
                    } while (FindNextFileW(h, out d));
                }
                finally { FindClose(h); }
            }
            RemoveDirectoryW(dir);
        }
    }

    /// <summary>
    /// JSON as far as this program reads it: objects (Dictionary), arrays (List), strings, numbers (double), true, false
    /// and null. Throws FormatException on anything else.
    /// </summary>
    public static class Json
    {
        public static object Parse(string s)
        {
            int at = 0;
            object v = Value(s, ref at);
            Space(s, ref at);
            if (at != s.Length) throw new FormatException("JSON: more after the value at " + at);
            return v;
        }

        static void Space(string s, ref int at)
        {
            while (at < s.Length && (s[at] == ' ' || s[at] == '\t' || s[at] == '\n' || s[at] == '\r')) at++;
        }

        static object Value(string s, ref int at)
        {
            Space(s, ref at);
            if (at >= s.Length) throw new FormatException("JSON: it ends early");
            char c = s[at];
            if (c == '{')
            {
                Dictionary<string, object> o = new Dictionary<string, object>();
                at++;
                Space(s, ref at);
                if (at < s.Length && s[at] == '}') { at++; return o; }
                while (true)
                {
                    Space(s, ref at);
                    if (at >= s.Length || s[at] != '"') throw new FormatException("JSON: a key at " + at);
                    string key = Str(s, ref at);
                    Space(s, ref at);
                    if (at >= s.Length || s[at] != ':') throw new FormatException("JSON: a colon at " + at);
                    at++;
                    o[key] = Value(s, ref at);
                    Space(s, ref at);
                    if (at < s.Length && s[at] == ',') { at++; continue; }
                    if (at < s.Length && s[at] == '}') { at++; return o; }
                    throw new FormatException("JSON: a comma or } at " + at);
                }
            }
            if (c == '[')
            {
                List<object> a = new List<object>();
                at++;
                Space(s, ref at);
                if (at < s.Length && s[at] == ']') { at++; return a; }
                while (true)
                {
                    a.Add(Value(s, ref at));
                    Space(s, ref at);
                    if (at < s.Length && s[at] == ',') { at++; continue; }
                    if (at < s.Length && s[at] == ']') { at++; return a; }
                    throw new FormatException("JSON: a comma or ] at " + at);
                }
            }
            if (c == '"') return Str(s, ref at);
            if (string.CompareOrdinal(s, at, "true", 0, 4) == 0) { at += 4; return true; }
            if (string.CompareOrdinal(s, at, "false", 0, 5) == 0) { at += 5; return false; }
            if (string.CompareOrdinal(s, at, "null", 0, 4) == 0) { at += 4; return null; }
            int start = at;
            while (at < s.Length && "+-0123456789.eE".IndexOf(s[at]) >= 0) at++;
            double d;
            if (at == start || !double.TryParse(s.Substring(start, at - start), NumberStyles.Float, CultureInfo.InvariantCulture, out d)) throw new FormatException("JSON: a value at " + start);
            return d;
        }

        static string Str(string s, ref int at)
        {
            StringBuilder b = new StringBuilder();
            at++;
            while (at < s.Length)
            {
                char c = s[at++];
                if (c == '"') return b.ToString();
                if (c != '\\') { b.Append(c); continue; }
                if (at >= s.Length) break;
                char e = s[at++];
                switch (e)
                {
                    case '"': b.Append('"'); break;
                    case '\\': b.Append('\\'); break;
                    case '/': b.Append('/'); break;
                    case 'b': b.Append('\b'); break;
                    case 'f': b.Append('\f'); break;
                    case 'n': b.Append('\n'); break;
                    case 'r': b.Append('\r'); break;
                    case 't': b.Append('\t'); break;
                    case 'u':
                        if (at + 4 > s.Length) throw new FormatException("JSON: a \\u at " + at);
                        b.Append((char)int.Parse(s.Substring(at, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        at += 4;
                        break;
                    default: throw new FormatException("JSON: an escape at " + at);
                }
            }
            throw new FormatException("JSON: a string that doesn't end");
        }

        /// <summary>A string as JSON, ASCII only (\uXXXX beyond it), so no console code page can spoil it.</summary>
        public static string Quote(string s)
        {
            if (s == null) return "null";
            StringBuilder b = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') b.Append("\\\"");
                else if (c == '\\') b.Append("\\\\");
                else if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4"));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }
    }

    /// <summary>
    /// Qwen2's tokenizer, as Hugging Face's tokenizers runs Qwen3's tokenizer.json: its added tokens split out first (the
    /// leftmost, then the longest), the rest NFC-normalized, split by its pattern, each piece's UTF-8 bytes as GPT-2's
    /// printable characters, then byte-pair merged by the merges' order. vocab.txt has a token a line (its line is its
    /// id), merges.txt a pair a line by rank, added.txt "id TAB text" a line (rerank-npu-export.ts writes them).
    /// One difference: .NET's regex sees a character beyond the BMP as two halves, so such a letter (rare scripts,
    /// mathematical letters) splits as punctuation does; an emoji splits the same either way.
    /// </summary>
    public sealed class Tokenizer
    {
        static readonly Regex Pieces = new Regex(@"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+", RegexOptions.CultureInvariant);
        readonly Dictionary<string, int> vocab = new Dictionary<string, int>(StringComparer.Ordinal);
        readonly Dictionary<string, int> ranks = new Dictionary<string, int>(StringComparer.Ordinal);
        readonly List<KeyValuePair<string, int>> added = new List<KeyValuePair<string, int>>();
        readonly Dictionary<string, int[]> cache = new Dictionary<string, int[]>(StringComparer.Ordinal);
        static readonly char[] ByteChar = ByteChars();

        /// <summary>GPT-2's bytes_to_unicode: the printable bytes as themselves, the others from U+0100 on.</summary>
        static char[] ByteChars()
        {
            char[] map = new char[256];
            int n = 0;
            for (int b = 0; b < 256; b++)
            {
                bool printable = (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);
                map[b] = printable ? (char)b : (char)(256 + n++);
            }
            return map;
        }

        public Tokenizer(string dir)
        {
            int id = 0;
            foreach (string line in File.ReadLines(Path.Combine(dir, "vocab.txt"), Encoding.UTF8)) vocab[line] = id++;
            int rank = 0;
            foreach (string line in File.ReadLines(Path.Combine(dir, "merges.txt"), Encoding.UTF8)) ranks[line] = rank++;
            foreach (string line in File.ReadLines(Path.Combine(dir, "added.txt"), Encoding.UTF8))
            {
                int tab = line.IndexOf('\t');
                if (tab > 0) added.Add(new KeyValuePair<string, int>(line.Substring(tab + 1), int.Parse(line.Substring(0, tab), CultureInfo.InvariantCulture)));
            }
        }

        public List<int> Encode(string text)
        {
            List<int> ids = new List<int>();
            int at = 0;
            while (at < text.Length)
            {
                // The leftmost added token from here, the longest there.
                int best = -1, bestId = 0, bestLength = 0;
                foreach (KeyValuePair<string, int> a in added)
                {
                    int i = text.IndexOf(a.Key, at, StringComparison.Ordinal);
                    if (i < 0) continue;
                    if (best < 0 || i < best || (i == best && a.Key.Length > bestLength)) { best = i; bestId = a.Value; bestLength = a.Key.Length; }
                }
                int end = best < 0 ? text.Length : best;
                if (end > at) Plain(text.Substring(at, end - at), ids);
                if (best < 0) break;
                ids.Add(bestId);
                at = best + bestLength;
            }
            return ids;
        }

        void Plain(string text, List<int> ids)
        {
            foreach (Match m in Pieces.Matches(text.Normalize(NormalizationForm.FormC)))
            {
                int[] got;
                if (!cache.TryGetValue(m.Value, out got))
                {
                    got = Bpe(m.Value);
                    if (cache.Count < 50000) cache[m.Value] = got;
                }
                ids.AddRange(got);
            }
        }

        int[] Bpe(string piece)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(piece);
            List<string> parts = new List<string>(bytes.Length);
            foreach (byte b in bytes) parts.Add(ByteChar[b].ToString());
            while (parts.Count > 1)
            {
                int best = -1, bestRank = int.MaxValue;
                for (int i = 0; i + 1 < parts.Count; i++)
                {
                    int r;
                    if (ranks.TryGetValue(parts[i] + " " + parts[i + 1], out r) && r < bestRank) { bestRank = r; best = i; }
                }
                if (best < 0) break;
                // Every occurrence of that pair, from the left.
                string a = parts[best], b2 = parts[best + 1];
                List<string> next = new List<string>(parts.Count);
                for (int i = 0; i < parts.Count; i++)
                {
                    if (i + 1 < parts.Count && parts[i] == a && parts[i + 1] == b2) { next.Add(a + b2); i++; }
                    else next.Add(parts[i]);
                }
                parts = next;
            }
            int[] ids = new int[parts.Count];
            for (int i = 0; i < parts.Count; i++)
            {
                int v;
                if (!vocab.TryGetValue(parts[i], out v)) throw new FormatException("the tokenizer has no token for a piece of the text");
                ids[i] = v;
            }
            return ids;
        }
    }

    /// <summary>The reranker: the template's tokens fitted to the graph, each looked up in the table, scored on a session.</summary>
    public sealed class Reranker : IDisposable
    {
        public const int Hidden = 1024;
        public const string Prefix = "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n<|im_start|>user\n";
        public const string Instruct = "Given a web search query, retrieve relevant passages that answer the query";
        public const string Suffix = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";
        public static readonly string Start = Prefix + "<Instruct>: " + Instruct + "\n<Query>:";

        readonly Tokenizer tok;
        readonly MemoryMappedFile table;
        readonly MemoryMappedViewAccessor rows;
        readonly int[] startIds;
        readonly int tail;
        public readonly int Tokens;
        Ort.Session session;

        public Reranker(string dir, int[] startIds, int tokens)
        {
            tok = new Tokenizer(dir);
            this.startIds = startIds;
            Tokens = tokens;
            List<int> mine = tok.Encode(Start);
            if (!Same(mine, startIds, startIds.Length) || mine.Count != startIds.Length)
                throw new FormatException("the tokenizer makes the template's start differently from the model's own tokenizer");
            tail = tok.Encode(Suffix).Count;
            table = MemoryMappedFile.CreateFromFile(Path.Combine(dir, "table.f32"), FileMode.Open, null, 0, MemoryMappedFileAccess.Read);
            rows = table.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
        }

        public Tokenizer Tokens_ { get { return tok; } }

        static bool Same(List<int> a, int[] b, int n)
        {
            if (a.Count < n || b.Length < n) return false;
            for (int i = 0; i < n; i++) if (a[i] != b[i]) return false;
            return true;
        }

        public void Use(Ort.Session s) { session = s; }

        /// <summary>
        /// The tokens after the start for a question and a document, at most Tokens of them, and whether the document
        /// was cut. Over Tokens (640: about 2,500 characters of English), the document's end goes: the question, the
        /// document's start and the template's end are kept, as the trial's server did. A question too long for the
        /// graph is cut too, and the document left out: its score is then the question's alone, never an error.
        /// </summary>
        public List<int> Fit(string query, string doc, out bool cut)
        {
            List<int> all = tok.Encode(Start + " " + query + "\n<Document>: " + doc + Suffix);
            if (!Same(all, startIds, startIds.Length)) throw new FormatException("the template's start tokenized differently");
            cut = all.Count - startIds.Length > Tokens;
            if (!cut) return all.GetRange(startIds.Length, all.Count - startIds.Length);
            // The question's tokens end at "<Document>:", which nothing after it can join, so they're the same alone.
            int head = tok.Encode(Start + " " + query + "\n<Document>:").Count;
            List<int> ids = new List<int>(Tokens);
            int room = Tokens - tail - (head - startIds.Length);
            if (room > 0)
            {
                ids.AddRange(all.GetRange(startIds.Length, head - startIds.Length + room));
            }
            else ids.AddRange(all.GetRange(startIds.Length, Tokens - tail));
            ids.AddRange(all.GetRange(all.Count - tail, tail));
            return ids;
        }

        /// <summary>A document's logit (the "yes" logit less the "no" one), and how many tokens it took with the start.</summary>
        public float Logit(string query, string doc, out int tokens, out bool cut)
        {
            List<int> ids = Fit(query, doc, out cut);
            float[] x = new float[Tokens * Hidden];
            for (int i = 0; i < ids.Count; i++) rows.ReadArray((long)ids[i] * Hidden * 4, x, i * Hidden, Hidden);
            float[] scores = session.Run(x, new long[] { 1, Tokens, Hidden });
            tokens = startIds.Length + ids.Count;
            return scores[ids.Count - 1];
        }

        /// <summary>The start's tokens looked up, [1, start, 1024], for its own graph.</summary>
        public float[] StartRows()
        {
            float[] x = new float[startIds.Length * Hidden];
            for (int i = 0; i < startIds.Length; i++) rows.ReadArray((long)startIds[i] * Hidden * 4, x, i * Hidden, Hidden);
            return x;
        }

        public static double Sigmoid(double x) { return 1 / (1 + Math.Exp(-x)); }

        public void Dispose()
        {
            if (session != null) session.Dispose();
            rows.Dispose();
            table.Dispose();
        }
    }

    public static class Program
    {
        const string VitisAi = "VitisAIExecutionProvider", AmdRuntime = "AMD's NPU runtime (VitisAI)";
        // A graph VitisAI couldn't compile, or that failed the check, this many times isn't tried again until its driver
        // or plugin changes.
        const int AmdTries = 2;
        static readonly object writeLock = new object();
        static string amdKey;

        static string Arg(string[] args, string name, string fallback)
        {
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
            return fallback;
        }

        static bool Has(string[] args, string name) { return Array.IndexOf(args, name) >= 0; }

        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetStdHandle(int which, IntPtr handle);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DuplicateHandle(IntPtr fromProcess, IntPtr handle, IntPtr toProcess, out IntPtr copy, uint access, bool inherit, uint options);
        [DllImport("ucrtbase.dll", CallingConvention = CallingConvention.Cdecl)] static extern int _dup2(int from, int to);

        /// <summary>The program's lines keep stdout to themselves; what the runtimes print goes to stderr (ocr-npu.cs' KeepStdoutForAnswers).</summary>
        static void KeepStdoutForAnswers()
        {
            IntPtr stdout = GetStdHandle(-11), mine;
            if (stdout == IntPtr.Zero || stdout == new IntPtr(-1)) return;
            if (!DuplicateHandle(GetCurrentProcess(), stdout, GetCurrentProcess(), out mine, 0, false, 2)) return;
            Stream answers = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(mine, true), FileAccess.Write);
            Console.SetOut(new StreamWriter(answers, new UTF8Encoding(false)));
            SetStdHandle(-11, GetStdHandle(-12));
            try { _dup2(2, 1); }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }

        static void Say(string line)
        {
            lock (writeLock)
            {
                Console.Out.Write(line + "\n");
                Console.Out.Flush();
            }
        }

        static void Log(string line)
        {
            lock (writeLock)
            {
                Console.Error.Write(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + line + "\n");
                Console.Error.Flush();
            }
        }

        static string Num(double v) { return v.ToString("R", CultureInfo.InvariantCulture); }

        /// <summary>rerank.json, as rerank-npu-export.ts writes it.</summary>
        sealed class About
        {
            public int[] StartIds;
            public int Tokens;
            public string CheckQuery;
            public string[] CheckDocuments;
            public string Graph;
        }

        static About ReadAbout(string dir)
        {
            Dictionary<string, object> j = Json.Parse(File.ReadAllText(Path.Combine(dir, "rerank.json"), Encoding.UTF8)) as Dictionary<string, object>;
            if (j == null) throw new FormatException("rerank.json isn't an object");
            About a = new About();
            List<object> ids = (List<object>)j["startIds"];
            a.StartIds = new int[ids.Count];
            for (int i = 0; i < ids.Count; i++) a.StartIds[i] = (int)(double)ids[i];
            a.Tokens = (int)(double)j["tokens"];
            a.Graph = (string)j["graph"];
            Dictionary<string, object> check = (Dictionary<string, object>)j["check"];
            a.CheckQuery = (string)check["query"];
            List<object> docs = (List<object>)check["documents"];
            a.CheckDocuments = new string[docs.Count];
            for (int i = 0; i < docs.Count; i++) a.CheckDocuments[i] = (string)docs[i];
            return a;
        }

        static string vitisAiPlugin;
        static bool vitisAiRegistered;

        static string VitisAiPlugin(string winml)
        {
            if (vitisAiPlugin == null) vitisAiPlugin = WindowsMl.Plugin(Path.Combine(winml, WindowsMl.Dll), VitisAi, AmdRuntime);
            return vitisAiPlugin;
        }

        static List<IntPtr> VitisAiNpus(Ort ort, string winml, string cache)
        {
            if (!vitisAiRegistered)
            {
                ort.Register(VitisAi, WindowsMl.Through(VitisAiPlugin(winml), Path.Combine(cache, "vitisai-plugin")));
                vitisAiRegistered = true;
            }
            List<IntPtr> npus = ort.Devices(VitisAi, 2);
            if (npus.Count == 0) throw new OrtException(AmdRuntime + " found no NPU on this PC.");
            return npus;
        }

        /// <summary>12 hex characters naming AMD's compile, as ocr-npu.cs' AmdKey does: the NPU's driver and the plugin.</summary>
        static string AmdKey(string plugin)
        {
            if (amdKey != null) return amdKey;
            StringBuilder named = new StringBuilder();
            using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{f01a9d53-3ff6-48d2-9f97-c8a7004be10c}"))
                if (k != null)
                {
                    string[] names = k.GetSubKeyNames();
                    Array.Sort(names, StringComparer.Ordinal);
                    foreach (string n in names)
                    {
                        try
                        {
                            using (Microsoft.Win32.RegistryKey d = k.OpenSubKey(n))
                                if (d != null) named.Append(d.GetValue("DriverDesc")).Append('=').Append(d.GetValue("DriverVersion")).Append('|');
                        }
                        catch (System.Security.SecurityException) { }
                    }
                }
            named.Append(plugin).Append('|');
            try { named.Append(FileVersionInfo.GetVersionInfo(plugin).FileVersion).Append('|').Append(new FileInfo(plugin).Length); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            using (SHA256 sha = SHA256.Create())
                amdKey = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(named.ToString())), 0, 6).Replace("-", "").ToLowerInvariant();
            return amdKey;
        }

        static string AmdPluginVersion(string plugin)
        {
            Match m = Regex.Match(plugin, @"\\[^\\_]+_(\d+(?:\.\d+){3})_[^\\]*\\");
            if (m.Success) return m.Groups[1].Value;
            try { return FileVersionInfo.GetVersionInfo(plugin).FileVersion ?? "unknown"; }
            catch (IOException) { return "unknown"; }
        }

        /// <summary>This driver's and plugin's folder of AMD's compiles in the cache.</summary>
        static string VitisAiDir(string winml, string cache) { return Path.Combine(cache, "vitisai-" + AmdKey(VitisAiPlugin(winml))); }

        static int Tries(string failed)
        {
            try { return int.Parse(File.ReadAllLines(failed)[0], CultureInfo.InvariantCulture); }
            catch (Exception e)
            {
                if (e is IOException || e is FormatException || e is IndexOutOfRangeException) return 0;
                throw;
            }
        }

        static void Failed(string failed, string why)
        {
            try { File.WriteAllText(failed, (Tries(failed) + 1).ToString(CultureInfo.InvariantCulture) + "\n" + why + "\n"); }
            catch (IOException) { }
        }

        /// <summary>
        /// The session on AMD's NPU through VitisAI, its shape fixed and the processor never taking part, one thread, as
        /// the trial's: VitisAI compiles the graph (FP32 run as BF16) into <paramref name="dir"/>'s cache_key folder once
        /// (about 36 minutes on a Ryzen AI 7 350), and opens it from there after that (about a second).
        /// </summary>
        static Ort.Session NpuSession(Ort ort, string winml, string cache, string dir, string model, string key)
        {
            List<IntPtr> npus = VitisAiNpus(ort, winml, cache);
            IntPtr o = ort.Options(1);
            try
            {
                ort.Config(o, "session.disable_cpu_ep_fallback", "1");
                Dictionary<string, string> settings = new Dictionary<string, string>();
                settings["cache_dir"] = dir;
                settings["cache_key"] = key;
                // Compiles that persist (AMD's in-memory cache file I/O can leave none on disk).
                settings["enable_cache_file_io_in_mem"] = "0";
                ort.Append(o, npus, settings);
                return ort.Open(model, o);
            }
            finally { ort.ReleaseOptions(o); }
        }

        static Ort.Session CpuSession(Ort ort, string model, int threads)
        {
            IntPtr o = ort.Options(threads);
            try { return ort.Open(model, o); }
            finally { ort.ReleaseOptions(o); }
        }

        /// <summary>--start: the start's keys and values, [56, 8, 60, 128], from start.onnx on the processor, into kv.f32.</summary>
        static int StartKv(string dir, string ortDir)
        {
            Stopwatch sw = Stopwatch.StartNew();
            try
            {
                About about = ReadAbout(dir);
                float[] kv;
                using (Reranker r = new Reranker(dir, about.StartIds, about.Tokens))
                {
                    Ort ort = new Ort(ortDir);
                    using (Ort.Session s = CpuSession(ort, Path.Combine(dir, "start.onnx"), 0))
                        kv = s.Run(r.StartRows(), new long[] { 1, about.StartIds.Length, Reranker.Hidden });
                }
                byte[] bytes = new byte[kv.Length * 4];
                Buffer.BlockCopy(kv, 0, bytes, 0, bytes.Length);
                string file = Path.Combine(dir, "kv.f32");
                File.WriteAllBytes(file + ".tmp", bytes);
                if (File.Exists(file)) File.Delete(file);
                File.Move(file + ".tmp", file);
                Say("{\"start\":1,\"values\":" + kv.Length + ",\"ms\":" + sw.ElapsedMilliseconds + "}");
                return 0;
            }
            catch (Exception e)
            {
                Say("{\"start\":0,\"ms\":" + sw.ElapsedMilliseconds + ",\"error\":" + Json.Quote(e.Message) + "}");
                return 1;
            }
        }

        /// <summary>The check's logits on <paramref name="s"/>, in its documents' order.</summary>
        static double[] CheckLogits(Reranker r, Ort.Session s, About about)
        {
            r.Use(s);
            double[] out_ = new double[about.CheckDocuments.Length];
            for (int i = 0; i < out_.Length; i++)
            {
                int n;
                bool cut;
                out_[i] = r.Logit(about.CheckQuery, about.CheckDocuments[i], out n, out cut);
            }
            return out_;
        }

        /// <summary>
        /// The check (kit's rule, as the text reader's: an NPU that answers differently isn't used): the NPU orders the
        /// check's documents as the processor does, and each score (the sigmoid) is within CheckTolerance of the processor's.
        /// </summary>
        public const double CheckTolerance = 0.1;

        static string CheckWhy(double[] cpu, double[] npu)
        {
            for (int i = 0; i < cpu.Length; i++)
            {
                if (Math.Abs(Reranker.Sigmoid(cpu[i]) - Reranker.Sigmoid(npu[i])) > CheckTolerance)
                    return "the NPU scored the check's document " + i + " " + Num(Math.Round(Reranker.Sigmoid(npu[i]), 4)) + " against the processor's " + Num(Math.Round(Reranker.Sigmoid(cpu[i]), 4));
                for (int j = 0; j < cpu.Length; j++)
                    if ((cpu[i] > cpu[j]) != (npu[i] > npu[j]) && i != j)
                        return "the NPU ordered the check's documents differently from the processor";
            }
            return null;
        }

        /// <summary>--compile: the NPU's graph compiled, opened once and closed: in a program of its own, as AMD's compiler ends its program on some graphs.</summary>
        static int CompileOne(string dir, string ortDir, string winml, string cache)
        {
            Stopwatch sw = Stopwatch.StartNew();
            try
            {
                About about = ReadAbout(dir);
                string vdir = VitisAiDir(winml, cache);
                Directory.CreateDirectory(vdir);
                // Its own working folder, for what VitisAI leaves there (its signature files).
                string work = Path.Combine(vdir, "work");
                Directory.CreateDirectory(work);
                Environment.CurrentDirectory = work;
                Ort ort = new Ort(ortDir);
                // Held while it compiles, so a --prepare started meanwhile (its own having ended) leaves the graph alone.
                using (Holding(Path.Combine(vdir, Key(about)) + ".compiling"))
                using (NpuSession(ort, winml, cache, vdir, Path.Combine(dir, about.Graph), Key(about))) { }
                Process me = Process.GetCurrentProcess();
                string said = "{\"compiled\":1,\"ms\":" + sw.ElapsedMilliseconds + ",\"peakMb\":" + (me.PeakPagedMemorySize64 >> 20) + ",\"cpuMs\":" + (long)me.TotalProcessorTime.TotalMilliseconds + "}";
                // For a --prepare after this one's own ended (its agent stopped meanwhile): the compile is checked, not done again.
                File.WriteAllText(Path.Combine(vdir, Key(about)) + ".compiled", said + "\n");
                Say(said);
                return 0;
            }
            catch (Exception e)
            {
                Say("{\"compiled\":0,\"ms\":" + sw.ElapsedMilliseconds + ",\"error\":" + Json.Quote(e.Message) + "}");
                return 1;
            }
        }

        /// <summary>The compile's name in the cache: the graph's length (the cache folder is the model's: rerank-npu.ts names it by the model's pins).</summary>
        static string Key(About about) { return "s" + about.Tokens; }

        /// <summary>A file held open for this program alone while it lives; null when another program holds it.</summary>
        static FileStream Holding(string file)
        {
            try { return new FileStream(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose); }
            catch (IOException) { return null; }
        }

        static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
            StringBuilder b = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { slashes++; continue; }
                b.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                slashes = 0;
                b.Append(c);
            }
            return b.Append('\\', slashes * 2).Append('"').ToString();
        }

        /// <summary>
        /// --prepare: the processor's answer to the check (once), the NPU's graph compiled in a program of its own below
        /// normal priority (CompileOne), then opened and checked. Ready (the graph's .ready) only when the check passes; a
        /// failure counts as a try (.failed), and after AmdTries none is made until the driver or the plugin changes.
        /// </summary>
        static int Prepare(string dir, string ortDir, string winml, string cache)
        {
            Stopwatch sw = Stopwatch.StartNew();
            string compiledSaid = "null";
            try
            {
                try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; }
                catch (System.ComponentModel.Win32Exception) { }
                About about = ReadAbout(dir);
                string vdir = VitisAiDir(winml, cache), graph = Path.Combine(vdir, Key(about));
                string ready = graph + ".ready", failed = graph + ".failed";
                Directory.CreateDirectory(vdir);
                if (File.Exists(ready) && Directory.Exists(graph))
                {
                    Say("{\"prepared\":1,\"compiled\":0,\"ms\":" + sw.ElapsedMilliseconds + ",\"plugin\":" + Json.Quote(AmdPluginVersion(VitisAiPlugin(winml))) + "}");
                    return 0;
                }
                int tries = Tries(failed);
                if (tries >= AmdTries)
                    throw new OrtException(AmdRuntime + " couldn't take the reranker (" + tries + " tries); it's tried again when AMD's NPU driver or runtime updates.");
                // One --prepare at a time, and none while a compile an earlier one started still runs.
                FileStream mine = Holding(graph + ".preparing");
                if (mine == null) { Say("{\"prepared\":0,\"busy\":1,\"ms\":" + sw.ElapsedMilliseconds + "}"); return 1; }
                using (mine)
                {
                    FileStream compiling = Holding(graph + ".compiling");
                    if (compiling == null) { Say("{\"prepared\":0,\"busy\":1,\"ms\":" + sw.ElapsedMilliseconds + "}"); return 1; }
                    compiling.Dispose();
                    return PrepareHeld(dir, ortDir, winml, cache, about, vdir, graph, ready, failed, sw, ref compiledSaid);
                }
            }
            catch (Exception e)
            {
                Say("{\"prepared\":0,\"ms\":" + sw.ElapsedMilliseconds + ",\"compile\":" + compiledSaid + ",\"error\":" + Json.Quote(e.Message) + "}");
                return 1;
            }
        }

        static int PrepareHeld(string dir, string ortDir, string winml, string cache, About about, string vdir, string graph, string ready, string failed, Stopwatch sw, ref string compiledSaid)
        {
            Ort ort = new Ort(ortDir);
            using (Reranker r = new Reranker(dir, about.StartIds, about.Tokens))
            {
                // The processor's answer, the check's yardstick, worked out once (a few seconds a document).
                string refFile = Path.Combine(dir, "check-cpu.txt");
                double[] cpu;
                if (File.Exists(refFile))
                {
                    string[] parts = File.ReadAllText(refFile).Trim().Split(',');
                    cpu = new double[parts.Length];
                    for (int i = 0; i < parts.Length; i++) cpu[i] = double.Parse(parts[i], CultureInfo.InvariantCulture);
                }
                else
                {
                    using (Ort.Session s = CpuSession(ort, Path.Combine(dir, about.Graph), 0))
                        cpu = CheckLogits(r, s, about);
                    string[] parts = new string[cpu.Length];
                    for (int i = 0; i < cpu.Length; i++) parts[i] = Num(cpu[i]);
                    File.WriteAllText(refFile, string.Join(",", parts) + "\n");
                    r.Use(null);
                }
                string compiled = graph + ".compiled";
                int exit = 0;
                if (File.Exists(compiled) && Directory.Exists(graph)) compiledSaid = File.ReadAllText(compiled).Trim();
                else
                {
                    // What a compile that never finished left goes first.
                    Tree.Delete(graph);
                    WindowsMl.Through(VitisAiPlugin(winml), Path.Combine(cache, "vitisai-plugin"));
                    StringBuilder a = new StringBuilder();
                    foreach (string s in new string[] { "--dir", dir, "--ort", ortDir, "--vitisai", winml, "--cache", cache, "--compile" }) a.Append(Quote(s)).Append(' ');
                    ProcessStartInfo start = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, a.ToString().Trim());
                    start.UseShellExecute = false;
                    start.CreateNoWindow = true;
                    start.RedirectStandardOutput = true;
                    using (Process p = Process.Start(start))
                    {
                        try { p.PriorityClass = ProcessPriorityClass.BelowNormal; }
                        catch (InvalidOperationException) { }
                        catch (System.ComponentModel.Win32Exception) { }
                        // Its id, so the caller can set it to its pace: Windows gives it this program's priority and job, but not its efficiency mode.
                        Say("{\"compiling\":" + p.Id + "}");
                        string line;
                        while ((line = p.StandardOutput.ReadLine()) != null) if (line.StartsWith("{\"compiled\":", StringComparison.Ordinal)) compiledSaid = line;
                        p.WaitForExit();
                        exit = p.ExitCode;
                    }
                    Tree.Delete(Path.Combine(vdir, "work"));
                }
                if (exit != 0 || compiledSaid == "null" || compiledSaid.Contains("\"error\":"))
                {
                    Failed(failed, compiledSaid == "null" ? "the compile ended without saying (exit " + exit + ")" : compiledSaid);
                    Tree.Delete(graph);
                    File.Delete(compiled);
                    throw new OrtException(AmdRuntime + " couldn't compile the reranker" + (compiledSaid == "null" ? " (its compiler ended, exit " + exit + ")" : ""));
                }
                double[] npu;
                using (Ort.Session s = NpuSession(ort, winml, cache, vdir, Path.Combine(dir, about.Graph), Key(about)))
                {
                    npu = CheckLogits(r, s, about);
                    r.Use(null);
                }
                string why = CheckWhy(cpu, npu);
                if (why != null)
                {
                    Failed(failed, why);
                    Tree.Delete(graph);
                    File.Delete(compiled);
                    throw new OrtException(why);
                }
                File.WriteAllText(ready, "");
                File.Delete(failed);
                // Only this driver's and plugin's compiles are kept.
                foreach (string d in Directory.GetDirectories(cache, "vitisai-*"))
                    if (!string.Equals(Path.GetFileName(d), Path.GetFileName(vdir), StringComparison.OrdinalIgnoreCase) && !string.Equals(Path.GetFileName(d), "vitisai-plugin", StringComparison.OrdinalIgnoreCase)) Tree.Delete(d);
                StringBuilder each = new StringBuilder();
                for (int i = 0; i < cpu.Length; i++) each.Append(i > 0 ? "," : "").Append("[").Append(Num(cpu[i])).Append(",").Append(Num(npu[i])).Append("]");
                Say("{\"prepared\":1,\"compiled\":1,\"ms\":" + sw.ElapsedMilliseconds + ",\"compile\":" + compiledSaid + ",\"check\":[" + each + "],\"plugin\":" + Json.Quote(AmdPluginVersion(VitisAiPlugin(winml))) + "}");
                return 0;
            }
        }

        // ------------------------------------------------------------------------------------------------
        // The server

        static Reranker server;
        static string alias = "qwen3-reranker-0.6b";
        static readonly object npuLock = new object();

        /// <summary>--serve: the NPU's compiled graph opened (it must be ready: --prepare), then requests answered until the program is stopped.</summary>
        static int Serve(string dir, string ortDir, string winml, string cache, string host, int port)
        {
            Stopwatch sw = Stopwatch.StartNew();
            About about = ReadAbout(dir);
            string vdir = VitisAiDir(winml, cache), graph = Path.Combine(vdir, Key(about));
            if (!File.Exists(graph + ".ready") || !Directory.Exists(graph)) throw new OrtException("the reranker isn't compiled for this NPU yet (" + graph + ")");
            Ort ort = new Ort(ortDir);
            server = new Reranker(dir, about.StartIds, about.Tokens);
            Environment.CurrentDirectory = vdir;
            server.Use(NpuSession(ort, winml, cache, vdir, Path.Combine(dir, about.Graph), Key(about)));
            TcpListener listener = new TcpListener(IPAddress.Parse(host), port);
            listener.Start();
            Process me = Process.GetCurrentProcess();
            Log("listening on " + host + ":" + port + " (opened in " + sw.ElapsedMilliseconds + " ms, " + (me.WorkingSet64 >> 20) + " MB)");
            while (true)
            {
                TcpClient c = listener.AcceptTcpClient();
                Thread t = new Thread(delegate () { Answer(c); });
                t.IsBackground = true;
                t.Start();
            }
        }

        static void Answer(TcpClient c)
        {
            using (c)
            {
                try
                {
                    c.ReceiveTimeout = 30000;
                    NetworkStream net = c.GetStream();
                    string method, path;
                    byte[] body = ReadRequest(net, out method, out path);
                    if (method == null) return;
                    int status = 200;
                    string json;
                    int q = path.IndexOf('?');
                    if (q >= 0) path = path.Substring(0, q);
                    if (method == "GET" && (path == "/v1/models" || path == "/models"))
                        json = "{\"object\":\"list\",\"data\":[{\"id\":" + Json.Quote(alias) + ",\"object\":\"model\",\"owned_by\":\"kit\"}]}";
                    else if (method == "GET" && path == "/health") json = "{\"status\":\"ok\"}";
                    else if (method == "POST" && (path == "/v1/rerank" || path == "/rerank" || path == "/v1/reranking" || path == "/reranking"))
                    {
                        try { json = Rerank(Encoding.UTF8.GetString(body)); }
                        catch (FormatException e) { status = 400; json = "{\"error\":{\"code\":400,\"message\":" + Json.Quote(e.Message) + ",\"type\":\"invalid_request_error\"}}"; }
                        catch (InvalidCastException) { status = 400; json = "{\"error\":{\"code\":400,\"message\":\"a rerank takes a query and documents (strings)\",\"type\":\"invalid_request_error\"}}"; }
                        catch (KeyNotFoundException) { status = 400; json = "{\"error\":{\"code\":400,\"message\":\"a rerank takes a query and documents\",\"type\":\"invalid_request_error\"}}"; }
                    }
                    else if (method == "POST") json = "{\"object\":\"chat.completion\",\"model\":" + Json.Quote(alias) + ",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":\"stop\"}]}";
                    else { status = 404; json = "{\"error\":{\"code\":404,\"message\":\"no such page\",\"type\":\"not_found_error\"}}"; }
                    byte[] reply = Encoding.UTF8.GetBytes(json);
                    string head = "HTTP/1.1 " + status + (status == 200 ? " OK" : status == 400 ? " Bad Request" : " Not Found") + "\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " + reply.Length + "\r\nConnection: close\r\n\r\n";
                    byte[] h = Encoding.ASCII.GetBytes(head);
                    net.Write(h, 0, h.Length);
                    net.Write(reply, 0, reply.Length);
                }
                catch (IOException) { }
                catch (Exception e)
                {
                    Log("a request failed: " + e.Message);
                    try
                    {
                        byte[] reply = Encoding.UTF8.GetBytes("{\"error\":{\"code\":500,\"message\":" + Json.Quote(e.Message) + ",\"type\":\"server_error\"}}");
                        byte[] h = Encoding.ASCII.GetBytes("HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: " + reply.Length + "\r\nConnection: close\r\n\r\n");
                        NetworkStream net = c.GetStream();
                        net.Write(h, 0, h.Length);
                        net.Write(reply, 0, reply.Length);
                    }
                    catch (Exception) { }
                }
            }
        }

        /// <summary>An HTTP/1.1 request's line and body (by its Content-Length; at most 64 MB); a null method when the client went away.</summary>
        static byte[] ReadRequest(Stream net, out string method, out string path)
        {
            method = null;
            path = null;
            MemoryStream head = new MemoryStream();
            int matched = 0, b;
            while (matched < 4)
            {
                b = net.ReadByte();
                if (b < 0) return null;
                head.WriteByte((byte)b);
                matched = (b == '\r' && (matched == 0 || matched == 2)) || (b == '\n' && (matched == 1 || matched == 3)) ? matched + 1 : (b == '\r' ? 1 : 0);
                if (head.Length > 65536) throw new FormatException("a request's headers are too long");
            }
            string[] lines = Encoding.ASCII.GetString(head.ToArray()).Split(new string[] { "\r\n" }, StringSplitOptions.None);
            string[] first = lines[0].Split(' ');
            if (first.Length < 2) return null;
            long length = 0;
            foreach (string l in lines)
            {
                int colon = l.IndexOf(':');
                if (colon > 0 && string.Equals(l.Substring(0, colon).Trim(), "Content-Length", StringComparison.OrdinalIgnoreCase))
                    long.TryParse(l.Substring(colon + 1).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out length);
            }
            if (length < 0 || length > (64L << 20)) throw new FormatException("a request's body is too long");
            byte[] body = new byte[length];
            int got = 0;
            while (got < length)
            {
                int n = net.Read(body, got, (int)length - got);
                if (n <= 0) return null;
                got += n;
            }
            method = first[0];
            path = first[1];
            return body;
        }

        sealed class Scored
        {
            public int Index;
            public double Score;
        }

        /// <summary>A rerank: each document scored in turn on the NPU (one at a time: one session), the best first, top_n of them.</summary>
        static string Rerank(string body)
        {
            Dictionary<string, object> req = Json.Parse(body) as Dictionary<string, object>;
            if (req == null) throw new FormatException("a rerank's body is a JSON object");
            string query = (string)req["query"];
            object docsValue;
            if (!req.TryGetValue("documents", out docsValue)) docsValue = req["texts"];
            List<object> docs = (List<object>)docsValue;
            int top = docs.Count;
            object topValue;
            if (req.TryGetValue("top_n", out topValue) && topValue is double && (double)topValue >= 0) top = Math.Min(docs.Count, (int)(double)topValue);
            Stopwatch sw = Stopwatch.StartNew();
            List<Scored> scored = new List<Scored>();
            int tokens = 0, cuts = 0;
            lock (npuLock)
            {
                TimeSpan cpu0 = Process.GetCurrentProcess().TotalProcessorTime;
                for (int i = 0; i < docs.Count; i++)
                {
                    int n;
                    bool cut;
                    float logit = server.Logit(query, (string)docs[i], out n, out cut);
                    Scored s = new Scored();
                    s.Index = i;
                    s.Score = Reranker.Sigmoid(logit);
                    scored.Add(s);
                    tokens += n;
                    if (cut) cuts++;
                }
                Log("reranked " + docs.Count + " in " + sw.ElapsedMilliseconds + " ms (" + (long)(Process.GetCurrentProcess().TotalProcessorTime - cpu0).TotalMilliseconds + " ms of processor), " + tokens + " tokens" + (cuts > 0 ? ", " + cuts + " cut to fit" : ""));
            }
            scored.Sort(delegate (Scored a, Scored b) { int c = b.Score.CompareTo(a.Score); return c != 0 ? c : a.Index.CompareTo(b.Index); });
            StringBuilder results = new StringBuilder();
            for (int i = 0; i < top; i++)
                results.Append(i > 0 ? "," : "").Append("{\"index\":").Append(scored[i].Index).Append(",\"relevance_score\":").Append(Num(scored[i].Score)).Append('}');
            return "{\"model\":" + Json.Quote(alias) + ",\"object\":\"list\",\"usage\":{\"prompt_tokens\":" + tokens + ",\"total_tokens\":" + tokens + "},\"results\":[" + results + "]}";
        }

        /// <summary>
        /// --status: whether the NPU's graph is compiled for this NPU's driver and plugin as they are now (a driver update
        /// needs a compile of its own), and how many tries of it failed; a second or so.
        /// </summary>
        static int Status(string dir, string winml, string cache)
        {
            try
            {
                About about = ReadAbout(dir);
                string graph = Path.Combine(VitisAiDir(winml, cache), Key(about));
                bool ready = File.Exists(graph + ".ready") && Directory.Exists(graph);
                Say("{\"ready\":" + (ready ? 1 : 0) + ",\"failed\":" + Tries(graph + ".failed") + ",\"giveUp\":" + (Tries(graph + ".failed") >= AmdTries ? 1 : 0) + ",\"plugin\":" + Json.Quote(AmdPluginVersion(VitisAiPlugin(winml))) + "}");
                return 0;
            }
            catch (Exception e)
            {
                Say("{\"ready\":0,\"error\":" + Json.Quote(e.Message) + "}");
                return 1;
            }
        }

        /// <summary>--tokenize: texts (UTF-8, split by NUL) as the reranker's tokenizer makes them, a line of ids each.</summary>
        static int Tokenize(string dir, string file)
        {
            Tokenizer tok = new Tokenizer(dir);
            foreach (string text in File.ReadAllText(file, Encoding.UTF8).Split('\0'))
            {
                List<int> ids = tok.Encode(text);
                StringBuilder b = new StringBuilder();
                for (int i = 0; i < ids.Count; i++) b.Append(i > 0 ? "," : "").Append(ids[i]);
                Say(b.ToString());
            }
            return 0;
        }

        public static int Main(string[] args)
        {
            KeepStdoutForAnswers();
            string dir = Arg(args, "--dir", null), ortDir = Arg(args, "--ort", null), winml = Arg(args, "--vitisai", null), cache = Arg(args, "--cache", null);
            try
            {
                if (dir == null) throw new ArgumentException("--dir names the reranker's model folder");
                if (Has(args, "--tokenize")) return Tokenize(dir, Arg(args, "--tokenize", null));
                if (ortDir == null) throw new ArgumentException("--ort names ONNX Runtime's folder");
                if (Has(args, "--start")) return StartKv(dir, ortDir);
                if (winml == null || cache == null) throw new ArgumentException("--vitisai and --cache name Windows ML's folder and the compiles'");
                Directory.CreateDirectory(cache);
                if (Has(args, "--status")) return Status(dir, winml, cache);
                if (Has(args, "--compile")) return CompileOne(dir, ortDir, winml, cache);
                if (Has(args, "--prepare")) return Prepare(dir, ortDir, winml, cache);
                if (Has(args, "--serve"))
                {
                    alias = Arg(args, "--alias", alias);
                    return Serve(dir, ortDir, winml, cache, Arg(args, "--host", "127.0.0.1"), int.Parse(Arg(args, "--port", "18185"), CultureInfo.InvariantCulture));
                }
                throw new ArgumentException("say --serve, --start, --prepare or --tokenize");
            }
            catch (Exception e)
            {
                Log("couldn't start: " + e.Message);
                return 1;
            }
        }
    }
}
