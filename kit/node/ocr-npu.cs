// The text reader's own model (spec/OCR.md, "Our own model"): finds the lines in a picture and reads them, on the NPU
// through ONNX Runtime's plugin for it, or on the processor, for ocr-npu.ts. A console program the kit compiles and
// signs like its other helpers (prebuilt.ts); C# 5, as Windows PowerShell's Add-Type compiles it.
//
//   ocr-npu.exe --ort <folder of onnxruntime.dll> --models <folder> --cache <folder> [--on npu|cpu]
//               [--qnn <folder>] [--openvino <folder>] [--vitisai <folder of Windows ML's DLL>] [--threads N]
//               [--htp <performance mode>] [--idle <seconds>] [--widths n,n,..] [--batches n,n,..] [--bench]
//               [--graphs <folder>] [--compiled-only] [--prepare [--export <folder>]]
//
// The models folder has det.onnx (the detector: [1,3,h,w] -> [1,1,h,w]), rec.onnx (the recognizer: [n,3,48,w] ->
// [n,w/s,classes], a step every s columns, 8 or 4) and charset.txt (the recognizer's characters, class 1 onwards; 0 is
// CTC's blank). On the NPU every shape is fixed: the detector reads tiles of Tile pixels, the recognizer lines Buckets
// wide, so many at a time (--batches, one for each width), each compiled once into the cache as an EP-context model.
// The processor reads the same tiles and widths, so both give the same answer. --bench prints each graph's time a run,
// and exits. The cache is the working folder, and has a folder for each pair of models as compiled.
//
// AMD's NPU (--vitisai) compiles each graph for minutes, each by a program of its own, as many at once as the PC's cores
// and memory allow (--prepare does only that, and exits; --export then copies them out for a release). Its compiler can't
// place a recognizer wider than 1,024 (AmdWidths), so a longer line is narrowed to that. --graphs gives graphs compiled
// ahead, used when this PC's plugin is the one that compiled them; --compiled-only reads on the processor rather than
// compile, its hello saying "prepare":true. As plugin 1.8.75 compiles the model (FP32 run as BF16) it reads worse than
// the processor, so the self-check refuses it (spec/OCR.md, "Intel and AMD").
//
// It says hello once, on one line of JSON: {"hello":1,"on":"npu"|"cpu","ep":"qnn"|...,"why":...,"loadMs":n,"compiled":n,...}
// (compiled: the graphs it compiled rather than loaded; Qualcomm's compiler holds 2 GB until the program ends). What
// the runtimes print goes to stderr, so stdout carries the program's lines alone.
// Then each line on stdin, <id> TAB <scale> TAB <orient 1|0> TAB <path>, gets one line back (orient 1 turns a photo the
// way its EXIF says; the width, height and boxes are the picture's own, as turned): {"id":n,"width":w,"height":h,"ms":n,
// "lines":[{"text":..,"words":[{"t":..,"x":..,"y":..,"w":..,"h":..}]}]} or {"id":n,"error":".."}. Answers are ASCII
// (\uXXXX beyond it), so no console code page can spoil them. It exits when stdin closes or after --idle seconds.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace KitOcrNpu
{
    public sealed class OrtException : Exception
    {
        public OrtException(string message) : base(message) { }
    }

    /// <summary>ONNX Runtime's C API (onnxruntime_c_api.h, API version 27): the functions this program uses, by their place in OrtApi.</summary>
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
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr FreeDimensionFn(IntPtr options, [MarshalAs(UnmanagedType.LPStr)] string name, long value);
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
        readonly ReleaseFn releaseStatus, releaseEnv, releaseSession, releaseOptions, releaseValue, releaseTypeAndShape;
        readonly CreateSessionOptionsFn createSessionOptions;
        readonly IntOptionFn setIntraOpThreads, setOptimization;
        readonly ConfigEntryFn addConfigEntry;
        readonly FreeDimensionFn addFreeDimension;
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
        readonly PointerOfFn epDeviceEpName, epDeviceDevice, hardwareVendor;
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
            releaseEnv = Fn<ReleaseFn>(92);
            releaseStatus = Fn<ReleaseFn>(93);
            releaseSession = Fn<ReleaseFn>(95);
            releaseValue = Fn<ReleaseFn>(96);
            releaseTypeAndShape = Fn<ReleaseFn>(99);
            releaseOptions = Fn<ReleaseFn>(100);
            addFreeDimension = Fn<FreeDimensionFn>(124);
            addConfigEntry = Fn<ConfigEntryFn>(130);
            registerEp = Fn<RegisterEpFn>(301);
            getEpDevices = Fn<GetEpDevicesFn>(303);
            appendEp = Fn<AppendEpFn>(304);
            hardwareType = Fn<IntOfFn>(307);
            hardwareVendor = Fn<PointerOfFn>(309);
            epDeviceEpName = Fn<PointerOfFn>(312);
            epDeviceDevice = Fn<PointerOfFn>(316);
            IntPtr env;
            Check(createEnv(3, "kit-ocr", out env));
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

        /// <summary>
        /// A session's options: its own threads (0: one a core), which never spin while they wait. Spinning, ONNX Runtime's
        /// default, kept five cores busy for a start on the NPU (3.9 s of processor in 0.8 s, measured on a Snapdragon X2).
        /// </summary>
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
        public void FixDimension(IntPtr options, string name, long value) { Check(addFreeDimension(options, name, value)); }
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

        public string Vendor(IntPtr epDevice) { return Marshal.PtrToStringAnsi(hardwareVendor(epDeviceDevice(epDevice))); }

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

            /// <summary>One float input in, the first output out with its shape.</summary>
            public float[] Run(float[] data, long[] shape, out long[] outShape)
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
                    UIntPtr rank;
                    long[] dims;
                    try
                    {
                        ort.Check(ort.getDimensionsCount(info, out rank));
                        dims = new long[(int)rank];
                        ort.Check(ort.getDimensions(info, dims, rank));
                    }
                    finally { ort.releaseTypeAndShape(info); }
                    long n = 1;
                    foreach (long d in dims) n *= d;
                    IntPtr p;
                    ort.Check(ort.getData(outputs[0], out p));
                    float[] result = new float[n];
                    Marshal.Copy(p, result, 0, (int)n);
                    outShape = dims;
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
    /// Windows ML's catalog of NPU plugins, through the C API of Microsoft.Windows.AI.MachineLearning.dll (ocr-npu.ts
    /// fetches that one file from Microsoft's NuGet package), as Envoy asks it (native/EnvoyMedia/WindowsMl.cs): Windows
    /// fetches the plugin for this PC's NPU from its maker (AMD's VitisAI), keeps it updated, and says where it is, and
    /// the program registers it with its own ONNX Runtime. Windows 11 24H2 (build 26100) or later.
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

        /// <summary>
        /// The plugin DLL Windows has for <paramref name="ep"/> ("VitisAIExecutionProvider", the full name), installed by
        /// Windows first when it isn't on the PC yet (seconds to minutes, once).
        /// </summary>
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
                // Ready (0), or not yet in this process (1): Windows installs it first if it must.
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
        /// <paramref name="dll"/> through a junction at <paramref name="link"/> to its folder, made, or pointed again after
        /// Windows updates the plugin into a new folder. AMD's needs it: from its own folder under WindowsApps its compiler
        /// can't open itself (found in Heiward). The path as it was when no junction can be made.
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
                    // A junction alone goes (never what it points to); a real folder that isn't empty throws.
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

        /// <summary>Where the junction <paramref name="link"/> points (its print name); null for another kind of link.</summary>
        static string Target(string link)
        {
            byte[] buf = new byte[16 * 1024];
            int got;
            using (Microsoft.Win32.SafeHandles.SafeFileHandle h = Open(link, 0x80000000))
                if (!DeviceIoControl(h, 0x000900A8, null, 0, buf, buf.Length, out got, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (BitConverter.ToUInt32(buf, 0) != MountPointTag) return null;
            int at = BitConverter.ToUInt16(buf, 12), length = BitConverter.ToUInt16(buf, 14);
            if (length > 0) return Encoding.Unicode.GetString(buf, 16 + at, length);
            // No print name (another tool's junction): its NT path.
            string nt = Encoding.Unicode.GetString(buf, 16 + BitConverter.ToUInt16(buf, 8), BitConverter.ToUInt16(buf, 10));
            return nt.StartsWith(@"\??\", StringComparison.Ordinal) ? nt.Substring(4) : nt;
        }

        /// <summary>Makes the empty folder <paramref name="link"/> a junction to <paramref name="target"/> (a mount point: no administrator needed).</summary>
        static void MountPoint(string link, string target)
        {
            // REPARSE_DATA_BUFFER, IO_REPARSE_TAG_MOUNT_POINT: tag, data length, reserved, then the NT path ("\??\C:\…") and
            // the path as shown, each with its offset and length in bytes and each ending in a NUL.
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

    /// <summary>
    /// A folder deleted with all in it, however deep: AMD's compiler leaves paths past 260 characters, which .NET 4.8's
    /// Directory.Delete can't reach (PathTooLongException). Through Windows' own calls on \\?\ paths; a junction inside
    /// goes, never what it points to. Never throws: what can't go stays.
    /// </summary>
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

        /// <summary>Deletes <paramref name="folder"/> and all in it; whether it's gone.</summary>
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

    /// <summary>A picture as rows of blue, green, red bytes, three to a pixel, no padding.</summary>
    public sealed class Picture
    {
        public readonly int Width, Height;
        public readonly byte[] Bgr;

        public Picture(int width, int height, byte[] bgr) { Width = width; Height = height; Bgr = bgr; }

        public static Picture Load(string path, bool orient)
        {
            using (Image image = Image.FromFile(path))
            {
                if (orient) Orient(image);
                return From(image);
            }
        }

        /// <summary>Turned the way a camera's EXIF orientation says, as a photo viewer shows it.</summary>
        static void Orient(Image image)
        {
            foreach (int id in image.PropertyIdList)
            {
                if (id != 0x0112) continue;
                PropertyItem p = image.GetPropertyItem(id);
                if (p.Value == null || p.Value.Length < 2) return;
                switch (BitConverter.ToUInt16(p.Value, 0))
                {
                    case 2: image.RotateFlip(RotateFlipType.RotateNoneFlipX); break;
                    case 3: image.RotateFlip(RotateFlipType.Rotate180FlipNone); break;
                    case 4: image.RotateFlip(RotateFlipType.Rotate180FlipX); break;
                    case 5: image.RotateFlip(RotateFlipType.Rotate90FlipX); break;
                    case 6: image.RotateFlip(RotateFlipType.Rotate90FlipNone); break;
                    case 7: image.RotateFlip(RotateFlipType.Rotate270FlipX); break;
                    case 8: image.RotateFlip(RotateFlipType.Rotate270FlipNone); break;
                }
                return;
            }
        }

        public static Picture From(Image image)
        {
            int w = image.Width, h = image.Height;
            Bitmap given = image as Bitmap;
            PixelFormat f = image.PixelFormat;
            if (given != null && (f == PixelFormat.Format24bppRgb || f == PixelFormat.Format32bppRgb || f == PixelFormat.Format32bppArgb))
            {
                // Read straight from its pixels, as drawing it on white would give them.
                bool alpha = f == PixelFormat.Format32bppArgb, four = f != PixelFormat.Format24bppRgb;
                BitmapData d = given.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, f);
                try
                {
                    byte[] bgr = new byte[w * h * 3];
                    byte[] row = new byte[Math.Abs(d.Stride)];
                    for (int y = 0; y < h; y++)
                    {
                        Marshal.Copy(new IntPtr(d.Scan0.ToInt64() + (long)y * d.Stride), row, 0, row.Length);
                        int o = y * w * 3;
                        if (!four) { Buffer.BlockCopy(row, 0, bgr, o, w * 3); continue; }
                        for (int x = 0; x < w; x++, o += 3)
                        {
                            int i = x * 4, a = alpha ? row[i + 3] : 255;
                            if (a == 255) { bgr[o] = row[i]; bgr[o + 1] = row[i + 1]; bgr[o + 2] = row[i + 2]; continue; }
                            for (int c = 0; c < 3; c++) bgr[o + c] = (byte)((row[i + c] * a + 255 * (255 - a) + 127) / 255);
                        }
                    }
                    return new Picture(w, h, bgr);
                }
                finally { given.UnlockBits(d); }
            }
            using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    // Transparent pictures read as they look on a white page.
                    g.Clear(Color.White);
                    g.DrawImage(image, new Rectangle(0, 0, w, h), 0, 0, w, h, GraphicsUnit.Pixel);
                }
                BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                try
                {
                    byte[] bgr = new byte[w * h * 3];
                    for (int y = 0; y < h; y++) Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), bgr, y * w * 3, w * 3);
                    return new Picture(w, h, bgr);
                }
                finally { bmp.UnlockBits(data); }
            }
        }

        public Picture Crop(int x0, int y0, int x1, int y1)
        {
            int w = x1 - x0, h = y1 - y0;
            byte[] o = new byte[w * h * 3];
            for (int y = 0; y < h; y++) Buffer.BlockCopy(Bgr, ((y0 + y) * Width + x0) * 3, o, y * w * 3, w * 3);
            return new Picture(w, h, o);
        }

        // ---- Resizing as Pillow's resize(BILINEAR) does it, which the model was trained with: a triangle filter as wide
        // as the scale when shrinking, fixed-point weights, across then down, rounded to bytes between the two. ----

        const int Precision = 22;

        static void Coefficients(int inSize, int outSize, out int[] bounds, out int[] weights, out int width)
        {
            double scale = (double)inSize / outSize;
            double filterScale = Math.Max(scale, 1.0);
            double support = filterScale;
            width = (int)Math.Ceiling(support) * 2 + 1;
            bounds = new int[outSize * 2];
            weights = new int[outSize * width];
            double[] k = new double[width];
            for (int xx = 0; xx < outSize; xx++)
            {
                double center = (xx + 0.5) * scale;
                double ss = 1.0 / filterScale;
                int xmin = (int)(center - support + 0.5);
                if (xmin < 0) xmin = 0;
                int xmax = (int)(center + support + 0.5);
                if (xmax > inSize) xmax = inSize;
                xmax -= xmin;
                double sum = 0;
                for (int x = 0; x < xmax; x++)
                {
                    double t = Math.Abs((x + xmin - center + 0.5) * ss);
                    double w = t < 1.0 ? 1.0 - t : 0.0;
                    k[x] = w;
                    sum += w;
                }
                for (int x = 0; x < width; x++)
                {
                    double w = x < xmax && sum != 0 ? k[x] / sum : 0;
                    weights[xx * width + x] = (int)(w < 0 ? w * (1 << Precision) - 0.5 : w * (1 << Precision) + 0.5);
                }
                bounds[xx * 2] = xmin;
                bounds[xx * 2 + 1] = xmax;
            }
        }

        static byte Clip(long v)
        {
            v >>= Precision;
            return v < 0 ? (byte)0 : v > 255 ? (byte)255 : (byte)v;
        }

        public Picture Resize(int nw, int nh)
        {
            Picture p = this;
            if (nw != Width)
            {
                int[] b, k;
                int kw;
                Coefficients(Width, nw, out b, out k, out kw);
                byte[] o = new byte[nw * Height * 3];
                for (int y = 0; y < Height; y++)
                {
                    int row = y * Width * 3;
                    for (int xx = 0; xx < nw; xx++)
                    {
                        int xmin = b[xx * 2], xmax = b[xx * 2 + 1];
                        long s0 = 1 << (Precision - 1), s1 = s0, s2 = s0;
                        for (int x = 0; x < xmax; x++)
                        {
                            int w = k[xx * kw + x], i = row + (x + xmin) * 3;
                            s0 += Bgr[i] * (long)w;
                            s1 += Bgr[i + 1] * (long)w;
                            s2 += Bgr[i + 2] * (long)w;
                        }
                        int j = (y * nw + xx) * 3;
                        o[j] = Clip(s0);
                        o[j + 1] = Clip(s1);
                        o[j + 2] = Clip(s2);
                    }
                }
                p = new Picture(nw, Height, o);
            }
            if (nh != p.Height)
            {
                int[] b, k;
                int kw;
                Coefficients(p.Height, nh, out b, out k, out kw);
                byte[] o = new byte[nw * nh * 3];
                for (int yy = 0; yy < nh; yy++)
                {
                    int ymin = b[yy * 2], ymax = b[yy * 2 + 1];
                    for (int x = 0; x < nw * 3; x++)
                    {
                        long s = 1 << (Precision - 1);
                        for (int y = 0; y < ymax; y++) s += p.Bgr[(y + ymin) * nw * 3 + x] * (long)k[yy * kw + y];
                        o[yy * nw * 3 + x] = Clip(s);
                    }
                }
                p = new Picture(nw, nh, o);
            }
            return p;
        }
    }

    public sealed class Word
    {
        public string Text;
        public double X, Y, W, H;
    }

    public sealed class Line
    {
        public List<Word> Words = new List<Word>();
        public string Text
        {
            get
            {
                List<string> t = new List<string>();
                foreach (Word w in Words) t.Add(w.Text);
                return string.Join(" ", t.ToArray());
            }
        }
    }

    /// <summary>The detector and the recognizer, on the NPU or the processor, and the reading between them.</summary>
    public sealed class Reader : IDisposable
    {
        public const int Tile = 640, Overlap = 64, Height = 48, ModelWidth = 2048;
        // Fewer on AMD's NPU (Program.AmdWidths), where each is a compile of minutes and 1,280 doesn't compile; --widths
        // sets them for a test.
        public static int[] Buckets = { 128, 256, 384, 512, 768, 1024, 1536, 2048 };
        /// <summary>The widest a line is read: the widest of Buckets (a wider line is narrowed to it).</summary>
        public static int MaxWidth { get { return Buckets[Buckets.Length - 1]; } }
        // The detector's settings (PP-OCR's DB post-processing, axis-aligned): what counts as text, a box's least mean
        // score, and how far a box grows past the shrunk text it finds.
        const float Thresh = 0.3f, BoxThresh = 0.5f, Unclip = 1.6f;
        static readonly float[] Mean = { 0.485f, 0.456f, 0.406f }, Std = { 0.229f, 0.224f, 0.225f };

        // Each pixel's value as the models take it: the detector's per colour (ImageNet's mean and spread), the recognizer's.
        static readonly float[][] DetValue = new float[3][];
        static readonly float[] RecValue = new float[256];

        static Reader()
        {
            for (int c = 0; c < 3; c++)
            {
                DetValue[c] = new float[256];
                for (int v = 0; v < 256; v++) DetValue[c][v] = (v / 255f - Mean[c]) / Std[c];
            }
            for (int v = 0; v < 256; v++) RecValue[v] = v / 127.5f - 1f;
        }

        readonly Func<int, Ort.Session> recFor;
        readonly int[] batches;
        readonly bool fixedBatch;
        readonly Ort.Session det;
        readonly string charset;
        readonly List<IDisposable> owned = new List<IDisposable>();

        /// <summary>
        /// batches: how many lines the recognizer reads at a time, for each of Buckets; fixedBatch when its graphs take
        /// exactly that many (the NPU's: a run short of lines is made up with blank ones), not up to it.
        /// </summary>
        public Reader(Ort.Session det, Func<int, Ort.Session> recFor, int[] batches, bool fixedBatch, string charset, IEnumerable<IDisposable> owned)
        {
            this.det = det;
            this.recFor = recFor;
            this.batches = batches;
            this.fixedBatch = fixedBatch;
            this.charset = charset;
            this.owned.AddRange(owned);
        }

        public void Dispose() { foreach (IDisposable d in owned) d.Dispose(); }

        // Where the last picture's time went, for the answer: the detector's runs, finding the boxes in what it gave (the
        // runs' time included), cutting them out and making them 48 high, the recognizer's runs, and how many boxes.
        public readonly Stopwatch DetTime = new Stopwatch(), FindTime = new Stopwatch(), PrepTime = new Stopwatch(), RecTime = new Stopwatch();
        public int BoxCount;

        static int[] Starts(int size)
        {
            List<int> s = new List<int>();
            if (size <= Tile) { s.Add(0); return s.ToArray(); }
            for (int p = 0; ; p += Tile - Overlap)
            {
                if (p + Tile >= size) { s.Add(size - Tile); break; }
                s.Add(p);
            }
            return s.ToArray();
        }

        /// <summary>The detector's text probability for each pixel: the picture read in tiles, overlaps taking the higher.</summary>
        public float[] Probabilities(Picture pic)
        {
            float[] prob = new float[pic.Width * pic.Height];
            float[] x = new float[3 * Tile * Tile];
            long[] shape = { 1, 3, Tile, Tile };
            foreach (int ty in Starts(pic.Height))
            {
                foreach (int tx in Starts(pic.Width))
                {
                    int th = Math.Min(Tile, pic.Height - ty), tw = Math.Min(Tile, pic.Width - tx);
                    // Only a picture smaller than a tile leaves part of it unfilled, to be read as 0.
                    if (th < Tile || tw < Tile) Array.Clear(x, 0, x.Length);
                    for (int y = 0; y < th; y++)
                    {
                        int row = ((ty + y) * pic.Width + tx) * 3;
                        for (int xx = 0; xx < tw; xx++)
                        {
                            int i = row + xx * 3, o = y * Tile + xx;
                            x[o] = DetValue[0][pic.Bgr[i]];
                            x[Tile * Tile + o] = DetValue[1][pic.Bgr[i + 1]];
                            x[2 * Tile * Tile + o] = DetValue[2][pic.Bgr[i + 2]];
                        }
                    }
                    long[] os;
                    DetTime.Start();
                    float[] p = det.Run(x, shape, out os);
                    DetTime.Stop();
                    int ow = (int)os[3];
                    for (int y = 0; y < th; y++)
                        for (int xx = 0; xx < tw; xx++)
                        {
                            int j = (ty + y) * pic.Width + tx + xx;
                            float v = p[y * ow + xx];
                            if (v > prob[j]) prob[j] = v;
                        }
                }
            }
            return prob;
        }

        /// <summary>The text's boxes: each run of likely-text pixels whose mean score is high enough, grown back to the text's size.</summary>
        public List<int[]> Boxes(Picture pic)
        {
            float[] prob = Probabilities(pic);
            int w = pic.Width, h = pic.Height;
            int[] label = new int[w * h];
            List<int[]> boxes = new List<int[]>();
            int[] stack = new int[w * h];
            int next = 0;
            for (int start = 0; start < w * h; start++)
            {
                if (prob[start] <= Thresh || label[start] != 0) continue;
                next++;
                int top = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
                double sum = 0;
                stack[top++] = start;
                label[start] = next;
                while (top > 0)
                {
                    int i = stack[--top];
                    int x = i % w, y = i / w;
                    n++;
                    sum += prob[i];
                    if (x < x0) x0 = x;
                    if (x > x1) x1 = x;
                    if (y < y0) y0 = y;
                    if (y > y1) y1 = y;
                    if (x > 0 && label[i - 1] == 0 && prob[i - 1] > Thresh) { label[i - 1] = next; stack[top++] = i - 1; }
                    if (x < w - 1 && label[i + 1] == 0 && prob[i + 1] > Thresh) { label[i + 1] = next; stack[top++] = i + 1; }
                    if (y > 0 && label[i - w] == 0 && prob[i - w] > Thresh) { label[i - w] = next; stack[top++] = i - w; }
                    if (y < h - 1 && label[i + w] == 0 && prob[i + w] > Thresh) { label[i + w] = next; stack[top++] = i + w; }
                }
                int bw = x1 + 1 - x0, bh = y1 + 1 - y0;
                if (Math.Min(bw, bh) < 3 || sum / n < BoxThresh) continue;
                double d = (double)bw * bh * Unclip / (2.0 * (bw + bh));
                int bx0 = Math.Max(0, (int)(x0 - d)), by0 = Math.Max(0, (int)(y0 - d));
                int bx1 = Math.Min(w, (int)Math.Ceiling(x1 + 1 + d)), by1 = Math.Min(h, (int)Math.Ceiling(y1 + 1 + d));
                boxes.Add(new int[] { bx0, by0, bx1, by1 });
            }
            return Distinct(boxes);
        }

        /// <summary>
        /// The boxes without those lying mostly (Inside) within a bigger one: a line taller than the tiles' overlap that
        /// crosses a seam is also found as a strip of itself, which reads as nonsense (seen on a scan rendered at 200%).
        /// </summary>
        public static List<int[]> Distinct(List<int[]> boxes)
        {
            const double Inside = 0.6;
            List<int[]> kept = new List<int[]>();
            for (int i = 0; i < boxes.Count; i++)
            {
                int[] a = boxes[i];
                long area = (long)(a[2] - a[0]) * (a[3] - a[1]);
                bool within = false;
                for (int j = 0; j < boxes.Count && !within; j++)
                {
                    int[] b = boxes[j];
                    long other = (long)(b[2] - b[0]) * (b[3] - b[1]);
                    // The smaller goes; of two the same size, the later.
                    if (j == i || other < area || (other == area && j > i)) continue;
                    long iw = Math.Min(a[2], b[2]) - Math.Max(a[0], b[0]), ih = Math.Min(a[3], b[3]) - Math.Max(a[1], b[1]);
                    within = iw > 0 && ih > 0 && iw * ih >= Inside * area;
                }
                if (!within) kept.Add(a);
            }
            return kept;
        }

        /// <summary>Boxes in rows by how they overlap up and down, each row left to right, the rows top to bottom.</summary>
        public static List<List<int[]>> Rows(List<int[]> boxes)
        {
            // Sorts here are stable (ties keep the boxes' order), as the reader the model was measured with sorts.
            List<int[]> sorted = StableSort(boxes, delegate (int[] a, int[] b) { return (a[1] + a[3]).CompareTo(b[1] + b[3]); });
            List<List<int[]>> rows = new List<List<int[]>>();
            foreach (int[] b in sorted)
            {
                double cy = (b[1] + b[3]) / 2.0;
                List<int[]> into = null;
                foreach (List<int[]> r in rows)
                {
                    int ry0 = int.MaxValue, ry1 = int.MinValue;
                    foreach (int[] x in r) { ry0 = Math.Min(ry0, x[1]); ry1 = Math.Max(ry1, x[3]); }
                    if (ry0 <= cy && cy <= ry1 && Math.Min(b[3], ry1) - Math.Max(b[1], ry0) > 0.5 * Math.Min(b[3] - b[1], ry1 - ry0)) { into = r; break; }
                }
                if (into != null) into.Add(b);
                else rows.Add(new List<int[]> { b });
            }
            List<List<int[]>> ordered = new List<List<int[]>>();
            foreach (List<int[]> r in rows) ordered.Add(StableSort(r, Compare));
            return StableSort(ordered, delegate (List<int[]> a, List<int[]> b) { return Top(a).CompareTo(Top(b)); });
        }

        static List<T> StableSort<T>(List<T> items, Comparison<T> compare)
        {
            List<KeyValuePair<int, T>> keyed = new List<KeyValuePair<int, T>>();
            for (int i = 0; i < items.Count; i++) keyed.Add(new KeyValuePair<int, T>(i, items[i]));
            keyed.Sort(delegate (KeyValuePair<int, T> a, KeyValuePair<int, T> b)
            {
                int c = compare(a.Value, b.Value);
                return c != 0 ? c : a.Key.CompareTo(b.Key);
            });
            List<T> o = new List<T>();
            foreach (KeyValuePair<int, T> kv in keyed) o.Add(kv.Value);
            return o;
        }

        static int Top(List<int[]> r) { int t = int.MaxValue; foreach (int[] x in r) t = Math.Min(t, x[1]); return t; }

        static int Compare(int[] a, int[] b)
        {
            for (int i = 0; i < 4; i++) { int c = a[i].CompareTo(b[i]); if (c != 0) return c; }
            return 0;
        }

        public static int BucketFor(int width)
        {
            foreach (int b in Buckets) if (width <= b) return b;
            return MaxWidth;
        }

        /// <summary>A box to read: where it is in the picture, and its crop made 48 high.</summary>
        sealed class Job
        {
            public int Left, Top, CropWidth, CropHeight, Bucket;
            public Picture Line;
            public List<Word> Words = new List<Word>();
        }

        static Job Prepare(Picture pic, int[] b)
        {
            Job j = new Job();
            j.Left = b[0];
            j.Top = b[1];
            j.CropWidth = b[2] - b[0];
            j.CropHeight = b[3] - b[1];
            int nw = Math.Min(MaxWidth, Math.Max(8, (int)Math.Ceiling(Height * (double)j.CropWidth / Math.Max(1, j.CropHeight))));
            j.Line = pic.Crop(b[0], b[1], b[2], b[3]).Resize(nw, Height);
            j.Bucket = BucketFor((nw + 7) / 8 * 8);
            return j;
        }

        /// <summary>The lines of each width read together, so many at a time, and each line's words placed by the steps its characters came at.</summary>
        void ReadAll(List<Job> jobs)
        {
            for (int k = 0; k < Buckets.Length; k++)
            {
                int W = Buckets[k], per = Math.Max(1, batches[k]);
                List<Job> group = jobs.FindAll(delegate (Job j) { return j.Bucket == W; });
                for (int at = 0; at < group.Count; at += per)
                {
                    int count = Math.Min(per, group.Count - at), n = fixedBatch ? per : count, size = 3 * Height * W;
                    float[] x = new float[n * size];
                    for (int i = 0; i < count; i++)
                    {
                        Picture p = group[at + i].Line;
                        int o = i * size;
                        // The rest of the width is left 0, the grey the model was trained with.
                        for (int y = 0; y < Height; y++)
                            for (int xx = 0; xx < p.Width; xx++)
                            {
                                int src = (y * p.Width + xx) * 3, dst = o + y * W + xx;
                                x[dst] = RecValue[p.Bgr[src]];
                                x[dst + Height * W] = RecValue[p.Bgr[src + 1]];
                                x[dst + 2 * Height * W] = RecValue[p.Bgr[src + 2]];
                            }
                    }
                    long[] os;
                    RecTime.Start();
                    float[] logits = recFor(W).Run(x, new long[] { n, 3, Height, W }, out os);
                    RecTime.Stop();
                    int steps = (int)os[1], classes = (int)os[2];
                    for (int i = 0; i < count; i++) Decode(logits, i * steps * classes, steps, classes, W, group[at + i]);
                }
            }
        }

        void Decode(float[] logits, int offset, int steps, int classes, int width, Job j)
        {
            // A step is the graph's width over its steps (8 or 4 of the line's columns), in the picture's own pixels.
            double perStep = (double)width / steps * j.CropWidth / j.Line.Width;
            StringBuilder sb = new StringBuilder();
            int prev = 0, first = -1, last = -1;
            for (int t = 0; t < steps; t++)
            {
                int at = offset + t * classes, best = 0;
                float bv = logits[at];
                for (int c = 1; c < classes; c++) if (logits[at + c] > bv) { bv = logits[at + c]; best = c; }
                if (best != prev && best != 0 && best <= charset.Length)
                {
                    char ch = charset[best - 1];
                    if (ch == ' ') { Flush(j, sb, first, last, perStep); first = -1; }
                    else
                    {
                        if (first < 0) first = t;
                        last = t;
                        sb.Append(ch);
                    }
                }
                prev = best;
            }
            Flush(j, sb, first, last, perStep);
        }

        static void Flush(Job j, StringBuilder sb, int first, int last, double perStep)
        {
            if (sb.Length == 0) return;
            Word w = new Word();
            w.Text = sb.ToString();
            w.X = j.Left + first * perStep;
            w.W = (last + 1 - first) * perStep;
            w.Y = j.Top;
            w.H = j.CropHeight;
            j.Words.Add(w);
            sb.Length = 0;
        }

        /// <summary>Each graph's time a run, in ms (the median of some runs on blank input), and how many lines a run reads: what to measure a new NPU by.</summary>
        public string Bench(int runs)
        {
            long[] os;
            Func<Ort.Session, long[], double> time = delegate (Ort.Session s, long[] shape)
            {
                float[] x = new float[shape[0] * shape[1] * shape[2] * shape[3]];
                s.Run(x, shape, out os);
                List<double> t = new List<double>();
                for (int i = 0; i < runs; i++)
                {
                    Stopwatch sw = Stopwatch.StartNew();
                    s.Run(x, shape, out os);
                    t.Add(sw.Elapsed.TotalMilliseconds);
                }
                t.Sort();
                return Math.Round(t[t.Count / 2], 2);
            };
            StringBuilder b = new StringBuilder("{\"det\":");
            b.Append(time(det, new long[] { 1, 3, Tile, Tile }).ToString(CultureInfo.InvariantCulture));
            for (int k = 0; k < Buckets.Length; k++)
            {
                int n = Math.Max(1, batches[k]);
                b.Append(",\"rec").Append(Buckets[k]).Append("\":{\"lines\":").Append(n).Append(",\"ms\":")
                 .Append(time(recFor(Buckets[k]), new long[] { n, 3, Height, Buckets[k] }).ToString(CultureInfo.InvariantCulture)).Append('}');
            }
            return b.Append('}').ToString();
        }

        public List<Line> ReadPicture(Picture pic)
        {
            DetTime.Reset();
            FindTime.Reset();
            PrepTime.Reset();
            RecTime.Reset();
            FindTime.Start();
            List<int[]> boxes = Boxes(pic);
            FindTime.Stop();
            BoxCount = boxes.Count;
            PrepTime.Start();
            List<List<Job>> rows = new List<List<Job>>();
            List<Job> jobs = new List<Job>();
            foreach (List<int[]> row in Rows(boxes))
            {
                List<Job> r = new List<Job>();
                foreach (int[] b in row) r.Add(Prepare(pic, b));
                rows.Add(r);
                jobs.AddRange(r);
            }
            PrepTime.Stop();
            ReadAll(jobs);
            List<Line> lines = new List<Line>();
            foreach (List<Job> r in rows)
            {
                Line line = new Line();
                foreach (Job j in r) line.Words.AddRange(j.Words);
                if (line.Words.Count > 0) lines.Add(line);
            }
            return lines;
        }
    }

    public static class Program
    {
        static readonly object writeLock = new object();
        static long lastActivity = Environment.TickCount;
        /// <summary>The graphs compiled by this start (not loaded from the cache): said in the hello.</summary>
        static int compiledNow;
        /// <summary>The arguments the compilers it starts take too: ONNX Runtime's folder, the models', AMD's graphs compiled ahead.</summary>
        static string ortDir, modelsDir, graphsDir;
        /// <summary>--compilers: how many of AMD's compilers run at once, when not as CompilersAtOnce finds.</summary>
        static int compilersGiven;
        /// <summary>The longest side a picture is read at: a 4K screen's as it is.</summary>
        const int MaxSide = 4096;

        static string Arg(string[] args, string name, string fallback)
        {
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
            return fallback;
        }

        public static string Json(string s)
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

        static string Num(double v) { return Math.Round(v, 1).ToString(CultureInfo.InvariantCulture); }

        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetStdHandle(int which, IntPtr handle);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DuplicateHandle(IntPtr fromProcess, IntPtr handle, IntPtr toProcess, out IntPtr copy, uint access, bool inherit, uint options);
        [DllImport("ucrtbase.dll", CallingConvention = CallingConvention.Cdecl)] static extern int _dup2(int from, int to);

        /// <summary>
        /// The answers keep stdout to themselves: the program writes them through its own copy of it, and what the
        /// runtimes print there (VitisAI's compiler, 1.4 MB of it for the nine graphs) goes to stderr instead.
        /// </summary>
        static void KeepStdoutForAnswers()
        {
            IntPtr stdout = GetStdHandle(-11), mine;
            if (stdout == IntPtr.Zero || stdout == new IntPtr(-1)) return;
            if (!DuplicateHandle(GetCurrentProcess(), stdout, GetCurrentProcess(), out mine, 0, false, 2)) return;
            Stream answers = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(mine, true), FileAccess.Write);
            Console.SetOut(new StreamWriter(answers, new UTF8Encoding(false)));
            SetStdHandle(-11, GetStdHandle(-12));
            // The C runtime's own stdout, for what's already loaded (DLLs loaded later take the handle set above).
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

        static string Hash(string file)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream f = File.OpenRead(file))
            {
                byte[] h = sha.ComputeHash(f);
                return BitConverter.ToString(h, 0, 6).Replace("-", "").ToLowerInvariant();
            }
        }

        /// <summary>
        /// A session on Qualcomm's NPU, compiled for it once into the cache as an EP-context model and loaded from it after
        /// that; every shape fixed, and the processor never taking part (CPU fallback off).
        /// </summary>
        static Ort.Session QnnSession(Ort ort, string qnn, string model, string cache, string name, Dictionary<string, long> dims, string htpMode)
        {
            ort.Register("QNNExecutionProvider", Path.Combine(qnn, "onnxruntime_providers_qnn.dll"));
            List<IntPtr> npus = ort.Devices("QNNExecutionProvider", 2);
            if (npus.Count == 0) throw new OrtException("Qualcomm's NPU runtime found no NPU on this PC.");
            string ctx = Path.Combine(cache, name + "_ctx.onnx");
            Func<bool, IntPtr> configured = delegate (bool compile)
            {
                // One thread: the NPU runs it all, the processor only hands it over.
                IntPtr o = ort.Options(1);
                ort.Config(o, "session.disable_cpu_ep_fallback", "1");
                foreach (KeyValuePair<string, long> d in dims) ort.FixDimension(o, d.Key, d.Value);
                if (compile)
                {
                    ort.Config(o, "ep.context_enable", "1");
                    ort.Config(o, "ep.context_file_path", ctx);
                    ort.Config(o, "ep.context_embed_mode", "1");
                }
                Dictionary<string, string> settings = new Dictionary<string, string>();
                settings["backend_path"] = Path.Combine(qnn, "QnnHtp.dll");
                settings["htp_performance_mode"] = htpMode;
                settings["enable_htp_fp16_precision"] = "1";
                // Its most thorough compiling: a line 1536 or 2048 wide reads in two thirds of the time.
                settings["htp_graph_finalization_optimization_mode"] = "3";
                ort.Append(o, npus, settings);
                return o;
            };
            Action compileIt = delegate ()
            {
                IntPtr o = configured(true);
                try { ort.Open(model, o).Dispose(); }
                finally { ort.ReleaseOptions(o); }
                compiledNow++;
            };
            if (!File.Exists(ctx)) compileIt();
            IntPtr lo = configured(false);
            try
            {
                try { return ort.Open(ctx, lo); }
                catch (OrtException)
                {
                    // Compiled by an older runtime: compiled again.
                    File.Delete(ctx);
                    compileIt();
                    return ort.Open(ctx, lo);
                }
            }
            finally { ort.ReleaseOptions(lo); }
        }

        /// <summary>
        /// A session on Intel's NPU through its OpenVINO plugin, every shape fixed, OpenVINO keeping what it compiles in the
        /// cache (its device's CACHE_DIR, in a load_config file, as Envoy found it needs).
        /// </summary>
        static Ort.Session OpenVinoSession(Ort ort, string openvino, string model, string cache, Dictionary<string, long> dims)
        {
            ort.Register("OpenVINOExecutionProvider", Path.Combine(openvino, "onnxruntime_providers_openvino_plugin.dll"));
            List<IntPtr> npus = ort.Devices("OpenVINOExecutionProvider", 2);
            if (npus.Count == 0) throw new OrtException("Intel's NPU runtime (OpenVINO) found no NPU on this PC: its driver may be missing.");
            string ovCache = Path.Combine(cache, "openvino");
            Directory.CreateDirectory(ovCache);
            string loadConfig = Path.Combine(ovCache, "load_config.json");
            File.WriteAllText(loadConfig, "{\"NPU\":{\"CACHE_DIR\":" + Json(ovCache) + "}}");
            IntPtr o = ort.Options(1);
            try
            {
                ort.Config(o, "session.disable_cpu_ep_fallback", "1");
                foreach (KeyValuePair<string, long> d in dims) ort.FixDimension(o, d.Key, d.Value);
                Dictionary<string, string> settings = new Dictionary<string, string>();
                settings["cache_dir"] = ovCache;
                settings["load_config"] = loadConfig;
                ort.Append(o, npus, settings);
                return ort.Open(model, o);
            }
            finally { ort.ReleaseOptions(o); }
        }

        const string VitisAi = "VitisAIExecutionProvider", AmdRuntime = "AMD's NPU runtime (VitisAI)";
        // A graph VitisAI couldn't compile this many times isn't tried again until its driver or plugin changes.
        const int AmdTries = 2;
        /// <summary>
        /// The recognizer's widths on AMD's NPU: a compile each, of 3.5 to 7.5 minutes (measured on a Ryzen AI 7 350, with
        /// Windows ML's VitisAI plugin 1.8.75), several at once beside the detector's 18. Its compiler can't place one
        /// 1,280 wide or more ("DMA channel location ... cannot access full range of the shared buffer memory space"), so
        /// the widest is 1,024, and a longer line is narrowed to it (on the processor, the check's 952 lines read the same
        /// so). Lines are read one at a time there: VitisAI leaves part of a batch of more to the processor, and refuses.
        /// </summary>
        public static readonly int[] AmdWidths = { 128, 256, 384, 512, 768, 1024 };
        static string vitisAiPlugin, amdKey;
        static bool vitisAiRegistered;

        /// <summary>The plugin Windows ML has for AMD's NPU (WindowsMl.Plugin), asked once.</summary>
        static string VitisAiPlugin(string winml)
        {
            if (vitisAiPlugin == null) vitisAiPlugin = WindowsMl.Plugin(Path.Combine(winml, WindowsMl.Dll), VitisAi, AmdRuntime);
            return vitisAiPlugin;
        }

        /// <summary>
        /// The plugin through the cache's vitisai-plugin junction (WindowsMl.Through), made before any compiler starts:
        /// compilers started together would race to make it.
        /// </summary>
        static string VitisAiThrough(string winml, string root)
        {
            return WindowsMl.Through(VitisAiPlugin(winml), Path.Combine(root, "vitisai-plugin"));
        }

        /// <summary>AMD's NPU, its VitisAI plugin registered with ONNX Runtime: its devices.</summary>
        static List<IntPtr> VitisAiNpus(Ort ort, string winml, string root)
        {
            if (!vitisAiRegistered)
            {
                ort.Register(VitisAi, VitisAiThrough(winml, root));
                vitisAiRegistered = true;
            }
            List<IntPtr> npus = ort.Devices(VitisAi, 2);
            if (npus.Count == 0) throw new OrtException(AmdRuntime + " found no NPU on this PC.");
            return npus;
        }

        /// <summary>
        /// 12 hex characters naming AMD's compiles, as Envoy's AmdKey does: the NPU's driver and the plugin Windows ML
        /// gave (the models are already in the cache folder's name), so an update to either compiles afresh.
        /// </summary>
        static string AmdKey(string plugin)
        {
            if (amdKey != null) return amdKey;
            StringBuilder named = new StringBuilder();
            // The NPU's driver, as Windows lists it among its compute accelerators.
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

        /// <summary>
        /// AMD's plugin as Windows ML installed it: its package's version (…\Microsoft.WinML.AMD.NPU.EP.Framework.2_1.8.75.0_x64__…\),
        /// else its DLL's. Graphs compiled ahead (--graphs) are used only by the plugin that compiled them.
        /// </summary>
        static string AmdPluginVersion(string plugin)
        {
            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(plugin, @"\\[^\\_]+_(\d+(?:\.\d+){3})_[^\\]*\\");
            if (m.Success) return m.Groups[1].Value;
            try { return FileVersionInfo.GetVersionInfo(plugin).FileVersion ?? "unknown"; }
            catch (IOException) { return "unknown"; }
        }

        /// <summary>This driver's and plugin's folder of AMD's compiles in the models' cache folder.</summary>
        static string VitisAiDir(string winml, string cache)
        {
            return Path.Combine(cache, "vitisai-" + AmdKey(VitisAiPlugin(winml)));
        }

        static int Tries(string failed)
        {
            try { return int.Parse(File.ReadAllLines(failed)[0], CultureInfo.InvariantCulture); }
            catch (Exception e)
            {
                if (e is IOException || e is FormatException || e is IndexOutOfRangeException) return 0;
                throw;
            }
        }

        /// <summary>The graphs not compiled yet in <paramref name="dir"/>; throws for one VitisAI has refused AmdTries times.</summary>
        static List<Graph> VitisAiMissing(string dir, List<Graph> graphs)
        {
            List<Graph> missing = new List<Graph>();
            foreach (Graph g in graphs)
            {
                string graph = Path.Combine(dir, g.Name);
                if (File.Exists(graph + ".ready") && Directory.Exists(graph)) continue;
                int tries = Tries(graph + ".failed");
                if (tries >= AmdTries) throw new OrtException(AmdRuntime + " couldn't compile the " + g.Name + " graph (" + tries + " tries); it's tried again when AMD's NPU driver or runtime updates.");
                missing.Add(g);
            }
            return missing;
        }

        /// <summary>
        /// The graph compiled ahead for this plugin and these models (--graphs: graphs.txt, and a .rai file each, as
        /// --prepare --export writes them), or null.
        /// </summary>
        static string ShippedGraph(string winml, string models, string name)
        {
            if (graphsDir == null) return null;
            string about = Path.Combine(graphsDir, "graphs.txt"), rai = Path.Combine(graphsDir, name + ".rai");
            if (!File.Exists(about) || !File.Exists(rai)) return null;
            Dictionary<string, string> said = new Dictionary<string, string>();
            foreach (string line in File.ReadAllLines(about))
            {
                int eq = line.IndexOf('=');
                if (eq > 0) said[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
            }
            string plugin, tag;
            if (!said.TryGetValue("plugin", out plugin) || plugin != AmdPluginVersion(VitisAiPlugin(winml))) return null;
            if (!said.TryGetValue("models", out tag) || tag != ModelTag(models)) return null;
            return rai;
        }

        /// <summary>
        /// A session on AMD's NPU through VitisAI, every shape fixed and the processor never taking part. VitisAI compiles
        /// each graph (the FP32 model runs in BF16) into its own folder in <paramref name="dir"/> once, and opens it from
        /// there after that; a graph compiled ahead for this plugin (--graphs) is put there instead of compiling it. A
        /// compile cut short is started again, and one that fails twice isn't tried again until the folder's key changes.
        /// </summary>
        static Ort.Session VitisAiSession(Ort ort, string winml, string root, string models, string dir, Graph g, out bool shipped)
        {
            List<IntPtr> npus = VitisAiNpus(ort, winml, root);
            string graph = Path.Combine(dir, g.Name), ready = graph + ".ready", failed = graph + ".failed";
            int tries = Tries(failed);
            if (tries >= AmdTries) throw new OrtException(AmdRuntime + " couldn't compile the " + g.Name + " graph (" + tries + " tries); it's tried again when AMD's NPU driver or runtime updates.");
            bool compiled = File.Exists(ready) && Directory.Exists(graph);
            string ahead = compiled ? null : ShippedGraph(winml, models, g.Name);
            shipped = false;
            Directory.CreateDirectory(dir);
            // What a compile that never finished left (the compiler's own folders, deep) goes first.
            if (!compiled) Tree.Delete(graph);
            if (ahead != null)
            {
                Directory.CreateDirectory(graph);
                File.Copy(ahead, Path.Combine(graph, g.Name + ".rai"), true);
                shipped = true;
            }
            Ort.Session s = null;
            Exception last = null;
            // Twice when a graph compiled ahead wasn't taken: then compiled here.
            for (int attempt = 0; attempt < 2 && s == null; attempt++)
            {
                IntPtr o = ort.Options(1);
                try
                {
                    ort.Config(o, "session.disable_cpu_ep_fallback", "1");
                    foreach (KeyValuePair<string, long> d in g.Dims) ort.FixDimension(o, d.Key, d.Value);
                    Dictionary<string, string> settings = new Dictionary<string, string>();
                    settings["cache_dir"] = dir;
                    settings["cache_key"] = g.Name;
                    ort.Append(o, npus, settings);
                    s = ort.Open(g.Model, o);
                }
                catch (OrtException e)
                {
                    last = e;
                    if (!shipped) break;
                    shipped = false;
                    Tree.Delete(graph);
                }
                finally { ort.ReleaseOptions(o); }
            }
            if (s == null)
            {
                if (!compiled)
                {
                    File.WriteAllText(failed, (tries + 1).ToString(CultureInfo.InvariantCulture) + "\n" + last.Message + "\n");
                    // A failed compile's folders (66 MB for one recognizer width) aren't kept; a compiled graph that
                    // didn't open (the NPU busy) is.
                    Tree.Delete(graph);
                }
                throw last;
            }
            if (!compiled)
            {
                File.WriteAllText(ready, shipped ? "shipped\n" : "");
                File.Delete(failed);
                compiledNow++;
            }
            return s;
        }

        /// <summary>Only this driver's and plugin's compiles are kept: an older one's folder goes once these have opened.</summary>
        static void KeepOnlyVitisAi(string cache)
        {
            string keep = "vitisai-" + amdKey;
            foreach (string d in Directory.GetDirectories(cache, "vitisai-*"))
            {
                if (string.Equals(Path.GetFileName(d), keep, StringComparison.OrdinalIgnoreCase)) continue;
                Tree.Delete(d);
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        sealed class MemoryStatus
        {
            public uint Length = 64, Load;
            public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GlobalMemoryStatusEx([In, Out] MemoryStatus status);

        // What one of AMD's compilers holds at most, with room to spare (1.2 GB measured, the detector's).
        const long CompilerBytes = 1536L << 20;

        /// <summary>How many graphs compile at once (--compilers, else one a core, as the memory free now allows), at least one.</summary>
        static int CompilersAtOnce(int graphs)
        {
            if (compilersGiven > 0) return Math.Min(graphs, compilersGiven);
            int cores = Math.Max(1, Environment.ProcessorCount / 2);
            MemoryStatus m = new MemoryStatus();
            long byMemory = GlobalMemoryStatusEx(m) ? (long)m.AvailPhys / CompilerBytes : 1;
            return (int)Math.Max(1, Math.Min(graphs, Math.Min(cores, byMemory)));
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
        /// Compiles <paramref name="missing"/> for AMD's NPU, each in a program of its own (--compile; AMD's compiler
        /// uses about one core), as many at once as CompilersAtOnce allows, the longest first, below normal priority so
        /// the PC's own work comes first. Each's time, and why for one that failed, as JSON.
        /// </summary>
        static string CompileInParallel(string winml, string root, List<Graph> missing, out int failures, out int atOnce)
        {
            // The junction before any compiler starts, so none races another to make it.
            VitisAiThrough(winml, root);
            string exe = Process.GetCurrentProcess().MainModule.FileName, dir = VitisAiDir(winml, ModelCache(root, modelsDir));
            int n = CompilersAtOnce(missing.Count);
            atOnce = n;
            SemaphoreSlim slots = new SemaphoreSlim(n, n);
            string[] said = new string[missing.Count];
            List<Thread> threads = new List<Thread>();
            int failed = 0;
            for (int i = 0; i < missing.Count; i++)
            {
                int at = i;
                Thread t = new Thread(delegate ()
                {
                    slots.Wait();
                    try
                    {
                        StringBuilder a = new StringBuilder();
                        foreach (string s in new string[] { "--ort", ortDir, "--models", modelsDir, "--cache", root, "--vitisai", winml, "--compile", missing[at].Name })
                            a.Append(Quote(s)).Append(' ');
                        if (graphsDir != null) a.Append("--graphs ").Append(Quote(graphsDir));
                        ProcessStartInfo start = new ProcessStartInfo(exe, a.ToString().Trim());
                        start.UseShellExecute = false;
                        start.CreateNoWindow = true;
                        start.RedirectStandardOutput = true;
                        string answer = null, graph = Path.Combine(dir, missing[at].Name), failedFile = graph + ".failed";
                        int triesBefore = Tries(failedFile), exit;
                        using (Process p = Process.Start(start))
                        {
                            try { p.PriorityClass = ProcessPriorityClass.BelowNormal; }
                            catch (InvalidOperationException) { }
                            catch (System.ComponentModel.Win32Exception) { }
                            string line;
                            while ((line = p.StandardOutput.ReadLine()) != null) if (line.StartsWith("{\"compiled\":", StringComparison.Ordinal)) answer = line;
                            p.WaitForExit();
                            exit = p.ExitCode;
                        }
                        if (exit != 0 || answer == null || answer.Contains("\"error\":"))
                        {
                            Interlocked.Increment(ref failed);
                            if (answer == null) answer = "{\"compiled\":" + Json(missing[at].Name) + ",\"error\":\"it ended without saying (exit " + exit + ")\"}";
                            // A compiler that ended without saying (AMD's ends its program on some graphs) counts as a try,
                            // and its folders go, as VitisAiSession does for one that says.
                            if (Tries(failedFile) <= triesBefore)
                            {
                                try { File.WriteAllText(failedFile, (triesBefore + 1).ToString(CultureInfo.InvariantCulture) + "\nit ended without saying (exit " + exit + ")\n"); }
                                catch (IOException) { }
                            }
                            if (!File.Exists(graph + ".ready")) Tree.Delete(graph);
                        }
                        said[at] = answer;
                    }
                    finally { slots.Release(); }
                });
                t.IsBackground = true;
                threads.Add(t);
                t.Start();
                // In order: the longest (the first) takes a slot first.
                Thread.Sleep(50);
            }
            foreach (Thread t in threads) t.Join();
            failures = failed;
            return "[" + string.Join(",", said) + "]";
        }

        /// <summary>The compilers' working folders, once they've ended.</summary>
        static void CleanWork(string dir)
        {
            foreach (string w in Directory.GetDirectories(dir, "work-*")) Tree.Delete(w);
        }

        /// <summary>--compile: one graph for AMD's NPU, compiled (or put in place, when compiled ahead), opened once and closed.</summary>
        static int CompileOne(string root, string winml, string name)
        {
            Stopwatch sw = Stopwatch.StartNew();
            try
            {
                Graph g = GraphNamed(modelsDir, name);
                string dir = VitisAiDir(winml, ModelCache(root, modelsDir));
                Directory.CreateDirectory(dir);
                // Its own working folder in the cache, for what VitisAI leaves there (its signature files), as no other compile's.
                string work = Path.Combine(dir, "work-" + name);
                Directory.CreateDirectory(work);
                Environment.CurrentDirectory = work;
                Ort ort = new Ort(ortDir);
                bool shipped;
                using (VitisAiSession(ort, winml, root, modelsDir, dir, g, out shipped)) { }
                Process me = Process.GetCurrentProcess();
                Say("{\"compiled\":" + Json(name) + ",\"ms\":" + sw.ElapsedMilliseconds + ",\"shipped\":" + (shipped ? "true" : "false") +
                    ",\"peakMb\":" + (me.PeakPagedMemorySize64 >> 20) + ",\"cpuMs\":" + (long)me.TotalProcessorTime.TotalMilliseconds + "}");
                return 0;
            }
            catch (Exception e)
            {
                Say("{\"compiled\":" + Json(name) + ",\"ms\":" + sw.ElapsedMilliseconds + ",\"error\":" + Json(e.Message) + "}");
                return 1;
            }
        }

        /// <summary>
        /// --prepare: every graph of AMD's NPU not compiled yet, compiled (CompileInParallel), so the program starts on it
        /// in seconds after that; --export copies them, compiled, into a folder for --graphs (a release's).
        /// </summary>
        static int Prepare(string root, string winml, int[] given, string export)
        {
            Stopwatch sw = Stopwatch.StartNew();
            string each = "[]";
            try
            {
                try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; }
                catch (System.ComponentModel.Win32Exception) { }
                List<Graph> graphs = Graphs(modelsDir, given);
                string cache = ModelCache(root, modelsDir), dir = VitisAiDir(winml, cache);
                List<Graph> missing = VitisAiMissing(dir, graphs);
                int failures = 0, atOnce = 0;
                if (missing.Count > 0) each = CompileInParallel(winml, root, missing, out failures, out atOnce);
                CleanWork(dir);
                if (failures == 0)
                {
                    KeepOnlyVitisAi(cache);
                    if (export != null) Export(winml, dir, graphs, export);
                }
                // What's kept: each graph's one compiled file.
                long bytes = 0;
                foreach (Graph g in graphs)
                {
                    FileInfo rai = new FileInfo(Path.Combine(dir, g.Name, g.Name + ".rai"));
                    if (rai.Exists) bytes += rai.Length;
                }
                Say("{\"prepared\":" + (failures == 0 ? "1" : "0") + ",\"graphs\":" + graphs.Count + ",\"compiled\":" + missing.Count + ",\"failed\":" + failures +
                    ",\"atOnce\":" + atOnce + ",\"ms\":" + sw.ElapsedMilliseconds + ",\"bytes\":" + bytes + ",\"plugin\":" + Json(AmdPluginVersion(VitisAiPlugin(winml))) + ",\"each\":" + each + "}");
                return failures == 0 ? 0 : 1;
            }
            catch (Exception e)
            {
                Say("{\"prepared\":0,\"ms\":" + sw.ElapsedMilliseconds + ",\"error\":" + Json(e.Message) + ",\"each\":" + each + "}");
                return 1;
            }
        }

        /// <summary>The compiled graphs and graphs.txt (the plugin and the models they're for), for --graphs on another PC.</summary>
        static void Export(string winml, string dir, List<Graph> graphs, string into)
        {
            Directory.CreateDirectory(into);
            foreach (Graph g in graphs) File.Copy(Path.Combine(dir, g.Name, g.Name + ".rai"), Path.Combine(into, g.Name + ".rai"), true);
            File.WriteAllText(Path.Combine(into, "graphs.txt"), "plugin=" + AmdPluginVersion(VitisAiPlugin(winml)) + "\nmodels=" + ModelTag(modelsDir) + "\n");
        }
        static Ort.Session CpuSession(Ort ort, string model, int threads)
        {
            IntPtr o = ort.Options(threads);
            try { return ort.Open(model, o); }
            finally { ort.ReleaseOptions(o); }
        }

        /// <summary>The same reader on the processor: the self-check's yardstick, and the reader when the NPU can't be used.</summary>
        static Reader CpuReader(Ort ort, string models, string charset, int threads)
        {
            Ort.Session det = CpuSession(ort, Path.Combine(models, "det.onnx"), threads);
            Ort.Session rec = CpuSession(ort, Path.Combine(models, "rec.onnx"), threads);
            int[] batches = new int[Reader.Buckets.Length];
            for (int k = 0; k < batches.Length; k++) batches[k] = 8;
            return new Reader(det, delegate (int w) { return rec; }, batches, false, charset, new IDisposable[] { det, rec });
        }

        // Changed whenever how the graphs are compiled changes, so what the cache holds is compiled again.
        const string Compiled = "c1";

        /// <summary>
        /// The cache's folder for these models as compiled now, its time touched each start; other models' folders are left a
        /// week (an agent on an older kit may still use them) and then deleted.
        /// </summary>
        static string CacheFor(string cache, string tag)
        {
            string here = Path.Combine(cache, tag);
            Directory.CreateDirectory(here);
            Directory.SetLastWriteTimeUtc(here, DateTime.UtcNow);
            foreach (string d in Directory.GetDirectories(cache))
            {
                if (d == here || !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(d), "^[0-9a-f]{12}-[0-9a-f]{12}-c[0-9]+$")) continue;
                if (Directory.GetLastWriteTimeUtc(d) > DateTime.UtcNow.AddDays(-7)) continue;
                Tree.Delete(d);
            }
            return here;
        }

        /// <summary>One of the NPU's graphs: its name in the cache ("det", "rec512x1"), its model, and its fixed shape.</summary>
        sealed class Graph
        {
            public string Name, Model;
            public readonly Dictionary<string, long> Dims = new Dictionary<string, long>();
        }

        /// <summary>The NPU's graphs: the detector's tile, then the recognizer at each width, so many lines at a time (1 unless given).</summary>
        static List<Graph> Graphs(string models, int[] given)
        {
            List<Graph> all = new List<Graph> { GraphNamed(models, "det") };
            for (int k = 0; k < Reader.Buckets.Length; k++) all.Add(GraphNamed(models, "rec" + Reader.Buckets[k] + "x" + (given != null ? given[k] : 1)));
            return all;
        }

        static Graph GraphNamed(string models, string name)
        {
            Graph g = new Graph { Name = name };
            if (name == "det")
            {
                g.Model = Path.Combine(models, "det.onnx");
                g.Dims["h"] = Reader.Tile;
                g.Dims["w"] = Reader.Tile;
                return g;
            }
            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(name, "^rec([0-9]+)x([0-9]+)$");
            if (!m.Success) throw new OrtException("No graph is named " + name);
            g.Model = Path.Combine(models, "rec.onnx");
            g.Dims["n"] = long.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            g.Dims["w"] = long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            return g;
        }

        /// <summary>The models as compiled now: both files' hashes, and how they're compiled.</summary>
        static string ModelTag(string models)
        {
            return Hash(Path.Combine(models, "det.onnx")) + "-" + Hash(Path.Combine(models, "rec.onnx")) + "-" + Compiled;
        }

        static string ModelCache(string root, string models) { return CacheFor(root, ModelTag(models)); }

        /// <summary>AMD's NPU's graphs aren't all compiled, and --compiled-only says not to here: --prepare compiles them.</summary>
        sealed class NotReady : Exception
        {
            public NotReady(string message) : base(message) { }
        }

        static Reader NpuReader(Ort ort, string models, string charset, string root, string qnn, string openvino, string vitisai, string htpMode, int[] given, bool compiledOnly, out string ep)
        {
            string cache = ModelCache(root, models);
            List<Graph> graphs = Graphs(models, given);
            Func<Graph, Ort.Session> open;
            if (qnn != null)
            {
                ep = "qnn";
                open = delegate (Graph g) { return QnnSession(ort, qnn, g.Model, cache, g.Name, g.Dims, htpMode); };
            }
            else if (openvino != null)
            {
                ep = "openvino";
                open = delegate (Graph g) { return OpenVinoSession(ort, openvino, g.Model, cache, g.Dims); };
            }
            else if (vitisai != null)
            {
                ep = "vitisai";
                string dir = VitisAiDir(vitisai, cache);
                List<Graph> missing = VitisAiMissing(dir, graphs);
                if (missing.Count > 0)
                {
                    if (compiledOnly) throw new NotReady(AmdRuntime + " hasn't compiled the text reader's model yet (" + missing.Count + " of its " + graphs.Count + " graphs)");
                    int failures, atOnce;
                    string each = CompileInParallel(vitisai, root, missing, out failures, out atOnce);
                    CleanWork(dir);
                    if (failures > 0) throw new OrtException(AmdRuntime + " couldn't compile the text reader's model: " + each);
                    compiledNow += missing.Count;
                }
                open = delegate (Graph g) { bool shipped; return VitisAiSession(ort, vitisai, root, models, dir, g, out shipped); };
            }
            else throw new OrtException("No NPU runtime was given.");
            int[] batches = new int[Reader.Buckets.Length];
            for (int k = 0; k < batches.Length; k++) batches[k] = given != null ? given[k] : 1;
            List<IDisposable> owned = new List<IDisposable>();
            Ort.Session det = open(graphs[0]);
            owned.Add(det);
            Dictionary<int, Ort.Session> recs = new Dictionary<int, Ort.Session>();
            // Every width opened (compiled, the first time) now, so the first picture doesn't wait for one.
            for (int k = 0; k < Reader.Buckets.Length; k++)
            {
                recs[Reader.Buckets[k]] = open(graphs[k + 1]);
                owned.Add(recs[Reader.Buckets[k]]);
            }
            if (ep == "vitisai") KeepOnlyVitisAi(cache);
            return new Reader(det, delegate (int w) { return recs[w]; }, batches, true, charset, owned);
        }

        /// <summary>Lines drawn here and now (GDI+, ClearType, in the fonts every Windows PC has), for the self-check.</summary>
        static Picture SelfCheckPicture()
        {
            string[] text = {
                "The quick brown fox jumps over the lazy dog 0123456789",
                "C:\\Users\\Public\\Documents\\Report 2026-10-23.pdf",
                "https://example.com/search?q=npu&page=2 #42 $19.99",
            };
            string[] fonts = { "Segoe UI", "Consolas", "Arial" };
            using (Bitmap bmp = new Bitmap(720, 150, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.White);
                    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                    for (int i = 0; i < text.Length; i++)
                        using (Font f = new Font(fonts[i], 15, FontStyle.Regular, GraphicsUnit.Pixel))
                            g.DrawString(text[i], f, Brushes.Black, 16, 20 + i * 40);
                }
                return Picture.From(bmp);
            }
        }

        static string Texts(List<Line> lines)
        {
            List<string> t = new List<string>();
            foreach (Line l in lines) t.Add(l.Text);
            return string.Join("\n", t.ToArray());
        }

        static string Answer(int id, Picture pic, double scale, Reader reader, List<Line> lines, long loadMs, long ms)
        {
            StringBuilder b = new StringBuilder();
            b.Append("{\"id\":").Append(id).Append(",\"width\":").Append((int)Math.Round(pic.Width / scale)).Append(",\"height\":").Append((int)Math.Round(pic.Height / scale));
            b.Append(",\"ms\":").Append(ms);
            b.Append(",\"parts\":{\"load\":").Append(loadMs).Append(",\"det\":").Append(reader.DetTime.ElapsedMilliseconds)
             .Append(",\"find\":").Append(reader.FindTime.ElapsedMilliseconds).Append(",\"prep\":").Append(reader.PrepTime.ElapsedMilliseconds)
             .Append(",\"rec\":").Append(reader.RecTime.ElapsedMilliseconds).Append(",\"boxes\":").Append(reader.BoxCount).Append('}');
            b.Append(",\"lines\":[");
            for (int i = 0; i < lines.Count; i++)
            {
                if (i > 0) b.Append(',');
                b.Append("{\"text\":").Append(Json(lines[i].Text)).Append(",\"words\":[");
                for (int k = 0; k < lines[i].Words.Count; k++)
                {
                    Word w = lines[i].Words[k];
                    if (k > 0) b.Append(',');
                    b.Append("{\"t\":").Append(Json(w.Text)).Append(",\"x\":").Append(Num(w.X / scale)).Append(",\"y\":").Append(Num(w.Y / scale))
                     .Append(",\"w\":").Append(Num(w.W / scale)).Append(",\"h\":").Append(Num(w.H / scale)).Append('}');
                }
                b.Append("]}");
            }
            return b.Append("]}").ToString();
        }

        public static int Main(string[] args)
        {
            KeepStdoutForAnswers();
            Console.InputEncoding = new UTF8Encoding(false);
            ortDir = Arg(args, "--ort", null);
            string models = modelsDir = Arg(args, "--models", null), cache = Arg(args, "--cache", null);
            string on = Arg(args, "--on", "npu"), qnn = Arg(args, "--qnn", null), openvino = Arg(args, "--openvino", null), vitisai = Arg(args, "--vitisai", null);
            graphsDir = Arg(args, "--graphs", null);
            compilersGiven = int.Parse(Arg(args, "--compilers", "0"), CultureInfo.InvariantCulture);
            bool compiledOnly = Array.IndexOf(args, "--compiled-only") >= 0;
            string widthList = Arg(args, "--widths", null);
            if (widthList != null)
            {
                List<int> widths = new List<int>();
                foreach (string w in widthList.Split(',')) widths.Add(int.Parse(w, CultureInfo.InvariantCulture));
                for (int k = 0; k < widths.Count; k++)
                    if (widths[k] < 8 || widths[k] % 8 != 0 || (k > 0 && widths[k] <= widths[k - 1]) || widths[k] > Reader.ModelWidth)
                    {
                        Say("{\"hello\":1,\"error\":\"--widths takes widths in order, each a multiple of 8, at most " + Reader.ModelWidth + "\"}");
                        return 2;
                    }
                Reader.Buckets = widths.ToArray();
            }
            else if (vitisai != null) Reader.Buckets = AmdWidths;
            // Qualcomm's NPU held at power_saver, as Envoy holds it: burst reads a picture a few per cent faster, but holds
            // the NPU awake while the program waits; and asking for burst for each run and power_saver after costs more
            // (10 ms or so a run, measured) than burst saves.
            string htpMode = Arg(args, "--htp", "power_saver");
            int threads = int.Parse(Arg(args, "--threads", "4"), CultureInfo.InvariantCulture);
            int idle = int.Parse(Arg(args, "--idle", "120"), CultureInfo.InvariantCulture);
            string batchList = Arg(args, "--batches", null);
            int[] batches = null;
            if (batchList != null)
            {
                string[] given = batchList.Split(',');
                if (given.Length != Reader.Buckets.Length)
                {
                    Say("{\"hello\":1,\"error\":\"--batches takes " + Reader.Buckets.Length + " numbers, one for each width\"}");
                    return 2;
                }
                batches = new int[given.Length];
                for (int k = 0; k < given.Length; k++) batches[k] = Math.Max(1, int.Parse(given[k], CultureInfo.InvariantCulture));
            }
            if (ortDir == null || models == null || cache == null)
            {
                Say("{\"hello\":1,\"error\":\"usage: ocr-npu --ort <folder> --models <folder> --cache <folder>\"}");
                return 2;
            }
            string compileOne = Arg(args, "--compile", null);
            if (compileOne != null || Array.IndexOf(args, "--prepare") >= 0)
            {
                if (vitisai == null)
                {
                    Say("{\"prepared\":0,\"error\":\"--prepare and --compile are for AMD's NPU (--vitisai)\"}");
                    return 2;
                }
                Directory.CreateDirectory(cache);
                Environment.CurrentDirectory = cache;
                return compileOne != null ? CompileOne(cache, vitisai, compileOne) : Prepare(cache, vitisai, batches, Arg(args, "--export", null));
            }
            Stopwatch load = Stopwatch.StartNew();
            Reader reader;
            string ep = "cpu", why = null, check = null;
            bool prepare = false;
            try
            {
                // Run in the cache, where what a runtime leaves in the working folder (VitisAI's signature files) belongs.
                Directory.CreateDirectory(cache);
                Environment.CurrentDirectory = cache;
                Ort ort = new Ort(ortDir);
                string charset = File.ReadAllText(Path.Combine(models, "charset.txt"), Encoding.UTF8);
                Reader cpu = CpuReader(ort, models, charset, threads);
                reader = cpu;
                if (on == "npu")
                {
                    Reader npu = null;
                    try
                    {
                        npu = NpuReader(ort, models, charset, cache, qnn, openvino, vitisai, htpMode, batches, compiledOnly, out ep);
                        Picture pic = SelfCheckPicture();
                        string want = Texts(cpu.ReadPicture(pic)), got = Texts(npu.ReadPicture(pic));
                        check = got;
                        if (got != want) throw new OrtException("the NPU read the self-check picture differently from the processor (" + got.Replace("\n", " | ") + ")");
                        reader = npu;
                        cpu.Dispose();
                    }
                    catch (Exception e)
                    {
                        if (npu != null) npu.Dispose();
                        why = e.Message;
                        prepare = e is NotReady;
                        ep = "cpu";
                        on = "cpu";
                    }
                }
                Say("{\"hello\":1,\"on\":" + Json(on) + ",\"ep\":" + Json(ep) + ",\"why\":" + Json(why) + ",\"runtime\":" + Json(ort.Version) + ",\"loadMs\":" + load.ElapsedMilliseconds + ",\"compiled\":" + compiledNow + ",\"check\":" + Json(check) + ",\"prepare\":" + (prepare ? "true" : "false") + "}");
                if (Array.IndexOf(args, "--bench") >= 0)
                {
                    Say("{\"bench\":" + reader.Bench(20) + "}");
                    return 0;
                }
            }
            catch (Exception e)
            {
                Say("{\"hello\":1,\"error\":" + Json(e.Message) + "}");
                return 1;
            }
            Thread watch = new Thread(delegate ()
            {
                while (true)
                {
                    Thread.Sleep(1000);
                    if (unchecked(Environment.TickCount - Interlocked.Read(ref lastActivity)) > idle * 1000L) Environment.Exit(0);
                }
            });
            watch.IsBackground = true;
            watch.Start();
            string request;
            while ((request = Console.In.ReadLine()) != null)
            {
                Interlocked.Exchange(ref lastActivity, Environment.TickCount);
                string[] parts = request.Split(new char[] { '\t' }, 4);
                if (parts.Length < 4) continue;
                int id = int.Parse(parts[0], CultureInfo.InvariantCulture);
                try
                {
                    Stopwatch sw = Stopwatch.StartNew();
                    double scale = double.Parse(parts[1], CultureInfo.InvariantCulture);
                    Picture pic = Picture.Load(parts[3], parts[2] != "0");
                    // A phone's photo is read no bigger than MaxSide: as well, in a fraction of the time and memory.
                    scale = Math.Min(scale, (double)MaxSide / Math.Max(pic.Width, pic.Height));
                    if (scale != 1) pic = pic.Resize(Math.Max(1, (int)Math.Round(pic.Width * scale)), Math.Max(1, (int)Math.Round(pic.Height * scale)));
                    long loadMs = sw.ElapsedMilliseconds;
                    List<Line> lines = reader.ReadPicture(pic);
                    Say(Answer(id, pic, scale, reader, lines, loadMs, sw.ElapsedMilliseconds));
                }
                catch (Exception e)
                {
                    Say("{\"id\":" + id + ",\"error\":" + Json(e.Message) + "}");
                }
                Interlocked.Exchange(ref lastActivity, Environment.TickCount);
            }
            return 0;
        }
    }
}
