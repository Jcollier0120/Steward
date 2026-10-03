using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;

namespace Steward.Kit.Tests;

/// <summary>
/// The dotnet part on a real disk: turns, the line, eviction, the release rule, the plain lock and failure
/// markers, in a scratch folder (never the PC's own locks). The protocol's details are the vectors'
/// (VectorTests); these check the part's .NET and Win32 side carries them out.
/// </summary>
public sealed class LockTests : IDisposable {
	readonly string root = Path.Combine(Path.GetTempPath(), "steward-kit-dotnet-" + Guid.NewGuid().ToString("N"));
	string Locks => Path.Combine(root, "locks");
	string Npu => Path.Combine(Locks, "npu");
	string Queue => Npu + ".queue";
	string[] Tickets() => Directory.Exists(Queue) ? Directory.GetFiles(Queue, "*.ticket") : [];

	public LockTests() => Directory.CreateDirectory(Locks);

	public void Dispose() {
		try { Directory.Delete(root, true); } catch { }
	}

	/// <summary>Holds a lock folder the way any other program does: a live pid (this one).</summary>
	void HoldAsAnotherProgram(string dir) {
		Directory.CreateDirectory(dir);
		File.WriteAllText(Path.Combine(dir, "owner.json"), $$"""{"pid":{{Environment.ProcessId}},"since":{{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}}}""");
	}

	/// <summary>The other program lets go; a waiter may be reading its owner.json just then, so it tries again, as a holder does.</summary>
	static void LetGo(string dir) {
		for (int attempt = 0; ; attempt++) {
			try {
				if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
				return;
			}
			catch (Exception e) when (e is IOException or UnauthorizedAccessException && attempt < 40) { Thread.Sleep(25); }
		}
	}

	static void Until(Func<bool> check) {
		var sw = Stopwatch.StartNew();
		while (!check()) {
			Assert.True(sw.Elapsed < TimeSpan.FromSeconds(10), "timed out waiting for the test condition");
			Thread.Sleep(20);
		}
	}

	[Fact]
	public void ATurn_WritesTheOwnerFileEveryProgramReads_AndTheReleaseRemovesIt() {
		using (HeldLock held = AcceleratorLock.Acquire(Npu, new TurnOptions { Who = "test" })) {
			Assert.Equal(0, held.Slot);
			Assert.Equal(Npu, held.Folder);
			using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Npu, "owner.json")));
			Assert.Equal(Environment.ProcessId, doc.RootElement.GetProperty("pid").GetInt32());
			Assert.InRange(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - doc.RootElement.GetProperty("since").GetInt64(), 0, 60_000);
			Assert.Empty(Tickets()); // it left the line
		}
		Assert.False(Directory.Exists(Npu));
	}

	[Fact]
	public void WaitsForALiveHolder_ThenTimesOut_AndLeavesTheLine() {
		HoldAsAnotherProgram(Npu);
		var notes = new List<string>();
		var e = Assert.Throws<LockTimeoutException>(() => AcceleratorLock.Acquire(Npu, new TurnOptions { Wait = TimeSpan.FromMilliseconds(300), Note = notes.Add }));
		Assert.IsAssignableFrom<TimeoutException>(e);
		Assert.Matches(@"^timed out after 300 ms waiting for the NPU \(1 in line\)$", e.Message);
		Assert.Empty(Tickets());
		Assert.True(Directory.Exists(Npu)); // the other holder's lock stays
	}

	[Fact]
	public void EvictsAHolderThatDied_AndSaysSo() {
		Directory.CreateDirectory(Npu);
		// A pid that isn't running (Windows' pids are multiples of 4; this one is odd).
		File.WriteAllText(Path.Combine(Npu, "owner.json"), $$"""{"pid":{{int.MaxValue - 2}},"since":{{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}}}""");
		var notes = new List<string>();
		using (AcceleratorLock.Acquire(Npu, new TurnOptions { Wait = TimeSpan.FromSeconds(5), Note = notes.Add })) {
			using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Npu, "owner.json")));
			Assert.Equal(Environment.ProcessId, doc.RootElement.GetProperty("pid").GetInt32());
		}
		Assert.Contains("the NPU was held by a process that died or overstayed: taking it over", notes);
	}

	[Fact]
	public void ServesWaitersInLineOrder_APersonFirst() {
		HoldAsAnotherProgram(Npu);
		var order = new ConcurrentQueue<string>();
		var errors = new ConcurrentQueue<Exception>();
		var threads = new List<Thread>();
		try {
			foreach (var (label, interactive) in new[] { ("a", false), ("b", false), ("c", true) }) {
				var t = new Thread(() => {
					try { using (AcceleratorLock.Acquire(Npu, new TurnOptions { Wait = TimeSpan.FromSeconds(20), Interactive = interactive, Who = label })) order.Enqueue(label); }
					catch (Exception e) { errors.Enqueue(e); }
				});
				t.Start();
				threads.Add(t);
				int expected = threads.Count;
				Until(() => Tickets().Length == expected);
			}
			Thread.Sleep(400); // every waiter has read the line since the person joined
		}
		finally {
			LetGo(Npu);
			foreach (Thread t in threads) Assert.True(t.Join(TimeSpan.FromSeconds(20)));
		}
		Assert.Empty(errors);
		Assert.Equal(["c", "a", "b"], order);
		Assert.Empty(Tickets());
		Assert.False(Directory.Exists(Npu));
	}

	[Fact]
	public async Task ATicketSaysWhoAndWhichLane_AsEveryProgramWritesIt() {
		HoldAsAnotherProgram(Npu);
		var waiter = Task.Run(() => {
			using (AcceleratorLock.Acquire(Npu, new TurnOptions { Wait = TimeSpan.FromSeconds(20), Who = "heiward" })) { }
		});
		Until(() => Tickets().Length == 1);
		string ticket = Tickets()[0];
		Assert.Matches(@"^1-\d{17}-\d+-[0-9a-f]{8}\.ticket$", Path.GetFileName(ticket));
		using (var doc = JsonDocument.Parse(File.ReadAllText(ticket))) {
			Assert.Equal("heiward", doc.RootElement.GetProperty("who").GetString());
			Assert.Equal("background", doc.RootElement.GetProperty("lane").GetString());
			Assert.Equal(Environment.ProcessId, doc.RootElement.GetProperty("pid").GetInt32());
		}
		LetGo(Npu);
		await waiter.WaitAsync(TimeSpan.FromSeconds(20));
	}

	[Fact]
	public void LetsGo_EvenWhileAnotherProgramIsReadingTheOwnerFile() {
		HeldLock held = AcceleratorLock.Acquire(Npu);
		// A reader that doesn't share delete (as File.ReadAllText, or Python's open, opens it), for a moment.
		var reader = new FileStream(Path.Combine(Npu, "owner.json"), FileMode.Open, FileAccess.Read, FileShare.Read);
		var closer = new Thread(() => { Thread.Sleep(200); reader.Dispose(); });
		closer.Start();
		held.Dispose();
		closer.Join();
		Assert.False(Directory.Exists(Npu), "the release waits out the reader instead of leaving the lock taken");
	}

	[Fact]
	public void NeverRemovesALockThatPassedToSomeoneElse() {
		HeldLock held = AcceleratorLock.Acquire(Npu);
		// Evicted for overstaying, and the lock taken by another meanwhile.
		File.WriteAllText(Path.Combine(Npu, "owner.json"), $$"""{"pid":{{Environment.ProcessId}},"since":1}""");
		held.Dispose();
		Assert.True(Directory.Exists(Npu));
	}

	[Fact]
	public void TwoSlots_TheFirstHeldByAProgramThatKnowsNoSlots_TheSecondTaken() {
		string card = Path.Combine(Locks, "gpu-x");
		HoldAsAnotherProgram(card);
		using HeldLock held = AcceleratorLock.Acquire([card, card + ".2"], new TurnOptions { Wait = TimeSpan.FromSeconds(5) });
		Assert.Equal(1, held.Slot);
		Assert.Equal(card + ".2", held.Folder);
		Assert.True(File.Exists(Path.Combine(card + ".2", "owner.json")));
	}

	[Fact]
	public void MaxAhead_DeclinesALongLine_WithoutJoining() {
		HoldAsAnotherProgram(Npu);
		Directory.CreateDirectory(Queue);
		long us = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000;
		for (int i = 1; i <= 2; i++) File.WriteAllText(Path.Combine(Queue, $"1-{us - i * 1000:D17}-{Environment.ProcessId}-0000000{i}.ticket"), "{}");
		var e = Assert.Throws<QueueFullException>(() => AcceleratorLock.Acquire(Npu, new TurnOptions { MaxAhead = 2 }));
		Assert.Equal("2 already waiting for the NPU", e.Message);
		Assert.Equal(2, Tickets().Length);
	}

	[Fact]
	public async Task AnAsyncTurn_WaitsWithoutAThread() {
		HoldAsAnotherProgram(Npu);
		Task<HeldLock> turn = AcceleratorLock.AcquireAsync([Npu], new TurnOptions { Wait = TimeSpan.FromSeconds(20) });
		Until(() => Tickets().Length == 1);
		Assert.False(turn.IsCompleted);
		LetGo(Npu);
		using HeldLock held = await turn;
		Assert.True(Directory.Exists(Npu));
	}

	[Fact]
	public void ACancelledWait_LeavesTheLine() {
		HoldAsAnotherProgram(Npu);
		using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
		Assert.ThrowsAny<OperationCanceledException>(() => AcceleratorLock.Acquire(Npu, new TurnOptions { Cancel = cancel.Token }));
		Assert.Empty(Tickets());
	}

	[Fact]
	public void ThePlainLock_IsTaken_WaitedFor_AndReleased() {
		string dir = Path.Combine(root, "plain", "build");
		using (AcceleratorLock.Lock(dir)) {
			Assert.True(File.Exists(Path.Combine(dir, "owner.json")));
			var e = Assert.Throws<LockTimeoutException>(() => AcceleratorLock.Lock(dir, new TurnOptions { Wait = TimeSpan.FromMilliseconds(200) }));
			Assert.Equal($"timed out after 200 ms waiting for {dir}", e.Message);
		}
		Assert.False(Directory.Exists(dir));
	}

	// ---------------------------------------------------------------- failure markers

	[Fact]
	public void AFailureMarker_IsWrittenWhole_CountsTenMinutes_AndGoesOnSuccess() {
		string folder = Path.Combine(root, "accelerators");
		DateTime now = new(2026, 10, 2, 12, 0, 0, DateTimeKind.Utc);
		FailureMarkers.Mark(folder, "gpu-x", "DirectML could not open the model: 0x887A0005\n   at Microsoft.ML.OnnxRuntime...", "heiward", now);
		string file = Path.Combine(folder, "gpu-x.failed.json");
		Assert.Equal("{\n  \"since\": \"2026-10-02T12:00:00.000Z\",\n  \"reason\": \"DirectML could not open the model: 0x887A0005\",\n  \"by\": \"heiward\"\n}\n", File.ReadAllText(file));
		Assert.Empty(Directory.GetFiles(folder, "*.tmp"));
		KitFailure f = FailureMarkers.Read(folder, "gpu-x", now.AddMinutes(9.9))!;
		Assert.Equal(("DirectML could not open the model: 0x887A0005", "heiward", now, now.AddMinutes(10)), (f.Reason, f.By, f.SinceUtc, f.UntilUtc));
		Assert.Null(FailureMarkers.Read(folder, "gpu-x", now.AddMinutes(10)));
		Assert.Null(FailureMarkers.Read(folder, "gpu-y", now));
		Assert.Null(FailureMarkers.Read(folder, "..\\gpu-x", now));
		Assert.Throws<ArgumentException>(() => FailureMarkers.Mark(folder, "..\\elsewhere", "x", "y"));
		File.WriteAllText(file, "{ half a fi");
		Assert.Null(FailureMarkers.Read(folder, "gpu-x", now));
		Assert.True(FailureMarkers.Clear(folder, "gpu-x"));
		Assert.False(File.Exists(file));
		Assert.False(FailureMarkers.Clear(folder, "gpu-x"));
	}

	// ---------------------------------------------------------------- the core, hosted

	[Fact]
	public void TheCore_CarriesItsRulesAndVersion_AndAnswersFromManyThreads() {
		KitCore core = KitCore.Shared;
		Assert.Equal(TimeSpan.FromSeconds(15), core.Rules.Dead);
		Assert.Equal(TimeSpan.FromMinutes(10), core.Rules.FailedFor);
		string kitVersion = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "VERSION")).Trim();
		Assert.Equal(kitVersion, core.Version);
		Parallel.For(0, 200, i => Assert.Equal($"gpu-card-{i}", core.GpuId($"Card {i}")));
	}
}
