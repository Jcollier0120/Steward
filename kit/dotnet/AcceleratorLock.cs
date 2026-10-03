// The Steward's kit, its dotnet part: turns on an accelerator (the spec's NPU-QUEUE.md). The core's turn
// machine decides every step (KitCore, turn.js); this file carries its actions out on disk with .NET and
// Win32, and waits as it says. A program that knows nothing of slots (Heiward) passes an accelerator's
// first lock folder only, and takes turns through the same line as everyone else.

#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Steward.Kit {
	/// <summary>No turn came within the wait. Its message is the core's, a clause with no full stop.</summary>
	public sealed class LockTimeoutException(string message) : TimeoutException(message);

	/// <summary>The line was longer than the caller was willing to join (<see cref="TurnOptions.MaxAhead"/>).</summary>
	public sealed class QueueFullException(string message) : IOException(message);

	/// <summary>How a turn is taken. Everything left out is the spec's rules.json default.</summary>
	public sealed class TurnOptions {
		/// <summary>How long to wait in line (default rules.json's lock.waitMs, 5 minutes).</summary>
		public TimeSpan? Wait { get; init; }
		/// <summary>When a holder counts as overstayed (default rules.json's lock.staleMs, 10 minutes; callers may set more).</summary>
		public TimeSpan? Stale { get; init; }
		/// <summary>A person is waiting on this: the interactive lane. Default background.</summary>
		public bool Interactive { get; init; }
		/// <summary>Who this is, for whoever looks at the line ("heiward").</summary>
		public string Who { get; init; } = "dotnet";
		/// <summary>Don't join when this many already wait: <see cref="QueueFullException"/> at once.</summary>
		public int? MaxAhead { get; init; }
		/// <summary>The accelerator in messages (default "the NPU" for the NPU's lock, else the folder's name).</summary>
		public string? What { get; init; }
		/// <summary>Told what's worth a line in a log: waiting behind others, taking over from a holder that died.</summary>
		public Action<string>? Note { get; init; }
		public CancellationToken Cancel { get; init; }
	}

	/// <summary>A lock held. Disposing it lets go, only while owner.json still names this holder.</summary>
	public sealed class HeldLock : IDisposable {
		readonly KitCore core;
		readonly TurnStep held;
		readonly ITurnIo io;
		int released;

		/// <summary>Which slot (0 for the first), and its folder.</summary>
		public int Slot { get; }
		public string Folder { get; }

		internal HeldLock(KitCore core, TurnStep held, ITurnIo io, int slot, string folder) {
			this.core = core;
			this.held = held;
			this.io = io;
			Slot = slot;
			Folder = folder;
		}

		public void Dispose() {
			if (Interlocked.Exchange(ref released, 1) != 0) return;
			try { AcceleratorLock.Drive(core, core.Release(held, io.NowMs()), io); }
			catch { /* left for the next taker's stale check */ }
		}
	}

	/// <summary>What the core's machine asks of the world: its actions, the clock, and the waits.</summary>
	public interface ITurnIo {
		/// <summary>Carries out one action (an object with its "op"); its result, or <c>{ "error", "message" }</c>.</summary>
		JsonNode? Perform(JsonObject action);
		/// <summary>Wall-clock milliseconds since the Unix epoch.</summary>
		long NowMs();
		void Sleep(int ms, CancellationToken cancel);
		Task SleepAsync(int ms, CancellationToken cancel);
	}

	/// <summary>Turns on accelerators' locks and lines, and the plain lock, by the core's rules.</summary>
	public static class AcceleratorLock {
		/// <summary>Holds a lock folder (an accelerator's first slot) after waiting its turn in its line. Blocks.</summary>
		public static HeldLock Acquire(string lockDir, TurnOptions? options = null) => Acquire(new[] { lockDir }, options);

		/// <summary>
		/// Holds one of an accelerator's slots (its lock folders, side by side: <c>id</c>, <c>id.2</c> …) after waiting its
		/// turn in its line; the head of the line takes whichever is free. Blocks. Throws <see cref="LockTimeoutException"/>,
		/// <see cref="QueueFullException"/>, or an <see cref="IOException"/> when the disk refuses.
		/// </summary>
		public static HeldLock Acquire(IReadOnlyList<string> lockDirs, TurnOptions? options = null) {
			TurnOptions o = options ?? new();
			var (baseDir, names) = Place(lockDirs);
			var io = new DiskTurnIo(baseDir, o.Note);
			KitCore core = KitCore.Shared;
			return Held(core, Drive(core, core.StartTurn(Start(names, o, io)), io, o.Cancel), io, baseDir);
		}

		/// <summary>As <see cref="Acquire(IReadOnlyList{string}, TurnOptions?)"/>, waiting without blocking a thread.</summary>
		public static async Task<HeldLock> AcquireAsync(IReadOnlyList<string> lockDirs, TurnOptions? options = null) {
			TurnOptions o = options ?? new();
			var (baseDir, names) = Place(lockDirs);
			var io = new DiskTurnIo(baseDir, o.Note);
			KitCore core = KitCore.Shared;
			return Held(core, await DriveAsync(core, core.StartTurn(Start(names, o, io)), io, o.Cancel).ConfigureAwait(false), io, baseDir);
		}

		/// <summary>The plain lock, for a lock nobody queues for: its folder taken (a dead or overstayed holder evicted), retried until the wait is over.</summary>
		public static HeldLock Lock(string dir, TurnOptions? options = null) {
			TurnOptions o = options ?? new();
			var (baseDir, names) = Place(new[] { dir });
			var io = new DiskTurnIo(baseDir, o.Note);
			KitCore core = KitCore.Shared;
			var start = new JsonObject { ["folder"] = names[0], ["pid"] = Environment.ProcessId, ["nowMs"] = io.NowMs(), ["what"] = o.What ?? dir };
			if (o.Wait is { } w) start["waitMs"] = (long)w.TotalMilliseconds;
			if (o.Stale is { } s) start["staleMs"] = (long)s.TotalMilliseconds;
			return Held(core, Drive(core, core.StartLock(start), io, o.Cancel), io, baseDir);
		}

		/// <summary>
		/// Runs one of the core's machines from its first step until it ends: each step's actions in order, its wait,
		/// then the next step from what they gave. Its last step is returned. When anything throws on the way (or the
		/// wait is cancelled), the machine is aborted (its ticket leaves the line) and the exception passed on.
		/// </summary>
		public static TurnStep Drive(KitCore core, TurnStep first, ITurnIo io, CancellationToken cancel = default) {
			TurnStep r = first;
			try {
				while (true) {
					JsonArray results = Perform(r, io);
					if (r.Done != null) return r;
					if (r.WaitMs > 0) io.Sleep(r.WaitMs, cancel);
					cancel.ThrowIfCancellationRequested();
					r = core.Step(r, io.NowMs(), results);
				}
			}
			catch {
				Undo(core, r, io);
				throw;
			}
		}

		/// <summary>As <see cref="Drive"/>, waiting without blocking a thread.</summary>
		public static async Task<TurnStep> DriveAsync(KitCore core, TurnStep first, ITurnIo io, CancellationToken cancel = default) {
			TurnStep r = first;
			try {
				while (true) {
					JsonArray results = Perform(r, io);
					if (r.Done != null) return r;
					if (r.WaitMs > 0) await io.SleepAsync(r.WaitMs, cancel).ConfigureAwait(false);
					cancel.ThrowIfCancellationRequested();
					r = core.Step(r, io.NowMs(), results);
				}
			}
			catch {
				Undo(core, r, io);
				throw;
			}
		}

		static JsonArray Perform(TurnStep r, ITurnIo io) {
			var results = new JsonArray();
			foreach (JsonNode? a in r.Actions) results.Add(io.Perform(a!.AsObject()));
			return results;
		}

		static void Undo(KitCore core, TurnStep r, ITurnIo io) {
			try {
				foreach (JsonNode? a in core.Abort(r).Actions) {
					try { io.Perform(a!.AsObject()); } catch { }
				}
			}
			catch { /* a machine that had ended has nothing to undo */ }
		}

		static (string Base, string[] Names) Place(IReadOnlyList<string> lockDirs) {
			if (lockDirs.Count == 0) throw new ArgumentException("No lock folder.", nameof(lockDirs));
			string[] full = lockDirs.Select(d => Path.GetFullPath(d.TrimEnd('\\', '/'))).ToArray();
			string baseDir = Path.GetDirectoryName(full[0]) ?? throw new ArgumentException($"A lock folder needs a folder above it: {lockDirs[0]}", nameof(lockDirs));
			if (full.Any(d => !string.Equals(Path.GetDirectoryName(d), baseDir, StringComparison.OrdinalIgnoreCase)))
				throw new ArgumentException($"An accelerator's lock folders are side by side: {string.Join(", ", lockDirs)}", nameof(lockDirs));
			return (baseDir, full.Select(d => Path.GetFileName(d)).ToArray());
		}

		static JsonObject Start(string[] names, TurnOptions o, DiskTurnIo io) {
			var start = new JsonObject {
				["slots"] = new JsonArray(names.Select(n => (JsonNode?)n).ToArray()),
				["pid"] = Environment.ProcessId,
				["nowMs"] = io.NowMs(),
				["nowUs"] = NowUs(),
				["nonce"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant(),
				["lane"] = o.Interactive ? "interactive" : "background",
				["who"] = o.Who,
			};
			if (o.What != null) start["what"] = o.What;
			if (o.Wait is { } w) start["waitMs"] = (long)w.TotalMilliseconds;
			if (o.Stale is { } s) start["staleMs"] = (long)s.TotalMilliseconds;
			if (o.MaxAhead is { } m) start["maxAhead"] = m;
			return start;
		}

		static HeldLock Held(KitCore core, TurnStep taken, ITurnIo io, string baseDir) {
			JsonObject done = taken.Done!;
			if (done["held"] is JsonObject held) {
				int slot = held["slot"]!.GetValue<int>();
				string folder = JsonNode.Parse(taken.StateJson)!["slots"]![slot]!.GetValue<string>();
				return new HeldLock(core, taken, io, slot, Path.Combine(baseDir, folder));
			}
			string message = done["message"]?.GetValue<string>() ?? "the turn ended without the lock";
			throw done["error"]?.GetValue<string>() switch {
				"timeout" => new LockTimeoutException(message),
				"full" => new QueueFullException(message),
				_ => new IOException(message),
			};
		}

		static long lastUs;

		/// <summary>Wall-clock microseconds since the Unix epoch, strictly increasing within this process.</summary>
		static long NowUs() {
			long t = (DateTime.UtcNow.Ticks - DateTime.UnixEpoch.Ticks) / 10;
			while (true) {
				long last = Interlocked.Read(ref lastUs);
				long next = t > last ? t : last + 1;
				if (Interlocked.CompareExchange(ref lastUs, next, last) == last) return next;
			}
		}
	}

	/// <summary>The core's actions on disk, below the folder that holds the locks, with .NET and Win32.</summary>
	public sealed class DiskTurnIo(string baseDir, Action<string>? note = null) : ITurnIo {
		public long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

		public void Sleep(int ms, CancellationToken cancel) {
			if (cancel.CanBeCanceled) cancel.WaitHandle.WaitOne(ms);
			else Thread.Sleep(ms);
			cancel.ThrowIfCancellationRequested();
		}

		public Task SleepAsync(int ms, CancellationToken cancel) => Task.Delay(ms, cancel);

		string At(JsonObject a) {
			string path = baseDir;
			foreach (JsonNode? part in a["path"]!.AsArray()) path = Path.Combine(path, part!.GetValue<string>());
			return path;
		}

		static readonly UTF8Encoding Utf8 = new(false);

		public JsonNode? Perform(JsonObject a) {
			string op = a["op"]!.GetValue<string>();
			try {
				switch (op) {
					case "mkdirs":
						Directory.CreateDirectory(At(a));
						return null;
					case "write":
						File.WriteAllText(At(a), a["text"]!.GetValue<string>(), Utf8);
						return null;
					case "touch": {
						string file = At(a);
						if (!File.Exists(file)) return Error("ENOENT", $"no such file: {file}");
						File.SetLastWriteTimeUtc(file, DateTime.UtcNow);
						return null;
					}
					case "list": {
						string dir = At(a);
						var entries = new JsonArray();
						foreach (string path in Directory.EnumerateFileSystemEntries(dir)) {
							var info = new FileInfo(path);
							double? mtime = info.Exists ? Ms(info.LastWriteTimeUtc) : Directory.Exists(path) ? Ms(Directory.GetLastWriteTimeUtc(path)) : null;
							entries.Add((JsonNode)new JsonObject { ["name"] = Path.GetFileName(path), ["mtimeMs"] = mtime });
						}
						return new JsonObject { ["entries"] = entries };
					}
					case "alive":
						return new JsonObject { ["alive"] = new JsonArray(a["pids"]!.AsArray().Select(p => (JsonNode?)PidAlive(p!.GetValue<int>())).ToArray()) };
					case "remove": {
						string file = At(a);
						if (!File.Exists(file)) return Error("ENOENT", $"no such file: {file}");
						File.Delete(file);
						return null;
					}
					case "mkdir":
						return MakeDirectory(At(a));
					case "read": {
						// Shared read, write and delete: a holder's release must never fail while a reader has its owner.json open.
						using var file = new FileStream(At(a), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
						using var reader = new StreamReader(file, Utf8);
						return new JsonObject { ["text"] = reader.ReadToEnd() };
					}
					case "stat": {
						string path = At(a);
						if (Directory.Exists(path)) return new JsonObject { ["mtimeMs"] = Ms(Directory.GetLastWriteTimeUtc(path)) };
						if (File.Exists(path)) return new JsonObject { ["mtimeMs"] = Ms(File.GetLastWriteTimeUtc(path)) };
						return Error("ENOENT", $"no such file or folder: {path}");
					}
					case "rmdir": {
						string dir = At(a);
						if (!Directory.Exists(dir)) return null;
						Directory.Delete(dir, recursive: true);
						return null;
					}
					case "note":
						note?.Invoke(a["text"]!.GetValue<string>());
						return null;
					default:
						return Error("ENOSYS", $"no action {op}");
				}
			}
			catch (Exception e) when (e is IOException or UnauthorizedAccessException) {
				return Error(CodeOf(e), e.Message);
			}
		}

		static double Ms(DateTime utc) => (utc - DateTime.UnixEpoch).TotalMilliseconds;

		static JsonObject Error(string code, string message) => new() { ["error"] = code, ["message"] = message };

		/// <summary>A Node-style code for what .NET threw, as the core reads them.</summary>
		static string CodeOf(Exception e) => e switch {
			FileNotFoundException or DirectoryNotFoundException => "ENOENT",
			UnauthorizedAccessException => "EPERM",
			IOException io => (io.HResult & 0xFFFF) switch {
				2 or 3 => "ENOENT",
				5 => "EACCES",
				32 or 33 => "EBUSY", // a sharing or lock violation: another process has a file in it open
				145 => "ENOTEMPTY",
				183 or 80 => "EEXIST",
				_ => "EIO",
			},
			_ => "EIO",
		};

		/// <summary>Creates the folder, failing when it exists: the atomic test-and-set the lock rests on (.NET's Directory.CreateDirectory succeeds silently instead).</summary>
		static JsonObject? MakeDirectory(string path) {
			if (OperatingSystem.IsWindows()) {
				if (CreateDirectoryW(path, 0)) return null;
				int error = Marshal.GetLastPInvokeError();
				return Error(error switch { 183 => "EEXIST", 2 or 3 => "ENOENT", 5 => "EACCES", _ => "EIO" }, $"couldn't create {path} (Win32 error {error})");
			}
			if (mkdir(path, Convert.ToUInt32("777", 8)) == 0) return null;
			int errno = Marshal.GetLastPInvokeError();
			return Error(errno switch { 17 => "EEXIST", 2 => "ENOENT", 13 => "EACCES", _ => "EIO" }, $"couldn't create {path} (errno {errno})");
		}

		[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
		[return: MarshalAs(UnmanagedType.Bool)]
		static extern bool CreateDirectoryW(string path, nint securityAttributes);

		[DllImport("libc", SetLastError = true)]
		static extern int mkdir([MarshalAs(UnmanagedType.LPUTF8Str)] string path, uint mode);

		static bool PidAlive(int pid) {
			try {
				using var p = Process.GetProcessById(pid);
				return !p.HasExited;
			}
			catch (ArgumentException) { return false; } // no such process
			catch { return true; }
		}
	}
}
