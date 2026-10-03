using System.Text.Json.Nodes;

namespace Steward.Kit.Tests;

/// <summary>
/// The spec's vectors against the kit's core as the dotnet part runs it, in Jint: the queue's, the turn's step
/// by step (the core directly, and through the part's drive loop), and the accelerators'. The same files the
/// node part and the core itself run (kit\test\vectors.test.ts).
/// </summary>
public sealed class VectorTests {
	static readonly KitCore Core = KitCore.Shared;

	static JsonNode Spec(string file) => JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "spec", file)))!;

	static readonly JsonNode Queue = Spec("npu-queue-vectors.json");
	static readonly JsonNode Turns = Spec("turn-vectors.json");
	static readonly JsonNode Accel = Spec("accelerator-vectors.json");

	static IEnumerable<JsonNode> Each(JsonNode node, string key) => node[key]!.AsArray().Select(n => n!);

	static void Same(JsonNode? expected, JsonNode? actual, string what) =>
		Assert.True(JsonNode.DeepEquals(expected, actual), $"{what}\nexpected {expected?.ToJsonString() ?? "null"}\nactual   {actual?.ToJsonString() ?? "null"}");

	static JsonNode? Json(string text) => JsonNode.Parse(text);

	// ---------------------------------------------------------------- the queue

	[Fact]
	public void OrdersTheLine() {
		long nowUs = Queue["nowUs"]!.GetValue<long>();
		foreach (JsonNode c in Each(Queue, "order")) {
			List<QueueTicket> tickets = Each(c, "tickets").Select(t => Core.ParseTicket(t.GetValue<string>())).OfType<QueueTicket>().ToList();
			tickets.Sort((a, b) => Core.CompareTickets(a, b, nowUs));
			Assert.Equal(Each(c, "expected").Select(e => e.GetValue<string>()), tickets.Select(t => t.Name));
		}
	}

	[Fact]
	public void JudgesHeartbeats() {
		foreach (JsonNode d in Each(Queue, "dead")) {
			bool alive = d["pidAlive"]!.GetValue<bool>();
			Assert.True(d["dead"]!.GetValue<bool>() == Core.IsDeadTicket(TimeSpan.FromMilliseconds(d["ageMs"]!.GetValue<int>()), () => alive), d["case"]!.GetValue<string>());
		}
	}

	[Fact]
	public void JudgesHolders() {
		const long now = 1_790_000_000_000;
		foreach (JsonNode h in Each(Queue, "holders")) {
			var o = new JsonObject {
				["owner"] = h["owner"]!.GetValue<bool>() ? new JsonObject { ["pid"] = 4242, ["since"] = now - h["sinceAgeMs"]!.GetValue<long>() } : null,
				["folderMtimeMs"] = h["folderAgeMs"] is JsonValue age ? now - age.GetValue<long>() : null,
				["nowMs"] = now,
			};
			if (h["staleMs"] is JsonValue stale) o["staleMs"] = stale.GetValue<long>();
			string verdict = Json(Core.CallWithRules("holderState", o))!.GetValue<string>();
			if (verdict == "ask") {
				o["pidAlive"] = h["pidAlive"]!.GetValue<bool>();
				verdict = Json(Core.CallWithRules("holderState", o))!.GetValue<string>();
			}
			Assert.True(h["stale"]!.GetValue<bool>() == (verdict == "stale"), h["case"]!.GetValue<string>());
		}
	}

	[Fact]
	public void NamesTheFolders() {
		foreach (JsonNode c in Each(Queue, "slots")) {
			IReadOnlyList<string> folders = Core.LockFolders(c["id"]!.GetValue<string>(), c["slots"]!.GetValue<int>());
			Assert.Equal(Each(c, "folders").Select(f => f.GetValue<string>()), folders);
			Assert.Equal(c["queue"]!.GetValue<string>(), Core.QueueName(folders[0]));
		}
	}

	// ---------------------------------------------------------------- the turn, step by step

	public static IEnumerable<object[]> TurnCases() => Each(Turns, "cases").Select((c, i) => new object[] { i, c["case"]!.GetValue<string>() });

	static TurnStep Start(JsonNode start) {
		JsonObject o = start.DeepClone().AsObject();
		string machine = o["machine"]!.GetValue<string>();
		o.Remove("machine");
		return machine == "turn" ? Core.StartTurn(o) : Core.StartLock(o);
	}

	static void Matches(JsonNode expected, TurnStep r, string what) {
		Same(expected["actions"], r.Actions, $"{what}: actions");
		Assert.True((expected["waitMs"]?.GetValue<int>() ?? 0) == r.WaitMs, $"{what}: waitMs");
		Same(expected["done"], r.Done, $"{what}: done");
	}

	[Theory]
	[MemberData(nameof(TurnCases))]
	public void TheTurn_StepByStep_InTheCore(int index, string name) {
		JsonArray steps = Turns["cases"]![index]!["steps"]!.AsArray();
		TurnStep r = Start(Turns["cases"]![index]!["start"]!);
		Matches(steps[0]!, r, $"{name}, the start");
		for (int i = 1; i < steps.Count; i++) {
			JsonNode s = steps[i]!;
			r = s["release"] is JsonNode release
				? Core.Release(r, release["nowMs"]!.GetValue<long>())
				: Core.Step(r, s["observe"]!["nowMs"]!.GetValue<long>(), s["observe"]!["results"]!.DeepClone().AsArray());
			Matches(s, r, $"{name}, step {i}");
		}
	}

	/// <summary>Replays a case's steps as the world: checks each action, gives each result, and keeps the clock.</summary>
	sealed class Scripted(JsonArray steps) : ITurnIo {
		public int Step, Action;
		public readonly List<int> Waits = [];

		public JsonNode? Perform(JsonObject action) {
			Same(steps[Step]!["actions"]![Action], action, $"step {Step}, action {Action}");
			JsonNode? next = Step + 1 < steps.Count ? steps[Step + 1] : null;
			JsonNode? result = next?["observe"]?["results"]?[Action]?.DeepClone();
			Action++;
			return result;
		}

		public long NowMs() {
			Assert.Equal(steps[Step]!["actions"]!.AsArray().Count, Action);
			Step++;
			Action = 0;
			return steps[Step]!["observe"]!["nowMs"]!.GetValue<long>();
		}

		public void Sleep(int ms, CancellationToken cancel) => Waits.Add(ms);
		public Task SleepAsync(int ms, CancellationToken cancel) {
			Waits.Add(ms);
			return Task.CompletedTask;
		}
	}

	[Theory]
	[MemberData(nameof(TurnCases))]
	public void TheTurn_StepByStep_ThroughTheDriveLoop(int index, string name) {
		JsonArray steps = Turns["cases"]![index]!["steps"]!.AsArray();
		var io = new Scripted(steps);
		TurnStep r = AcceleratorLock.Drive(Core, Start(Turns["cases"]![index]!["start"]!), io);
		Same(steps[io.Step]!["done"], r.Done, name);
		if (io.Step + 1 < steps.Count) {
			io.Step++;
			io.Action = 0;
			r = AcceleratorLock.Drive(Core, Core.Release(r, steps[io.Step]!["release"]!["nowMs"]!.GetValue<long>()), io);
			Same(steps[io.Step]!["done"], r.Done, name);
		}
		Assert.Equal(steps.Count - 1, io.Step);
		Assert.Equal(steps.Where(s => s!["waitMs"] != null && s["done"] == null).Select(s => s!["waitMs"]!.GetValue<int>()), io.Waits);
	}

	[Fact]
	public async Task TheTurn_StepByStep_ThroughTheAsyncDriveLoop() {
		JsonNode c = Turns["cases"]![2]!; // waits behind others, then takes the lock
		JsonArray steps = c["steps"]!.AsArray();
		var io = new Scripted(steps);
		TurnStep r = await AcceleratorLock.DriveAsync(Core, Start(c["start"]!), io);
		Same(steps[io.Step]!["done"], r.Done, c["case"]!.GetValue<string>());
		Assert.NotEmpty(io.Waits);
	}

	// ---------------------------------------------------------------- the accelerators

	static readonly long Now = Accel["nowMs"]!.GetValue<long>();

	static JsonArray Accelerators(JsonNode config) => Json(Core.CallWithRules("parseAccelerators", config.DeepClone()))!["accelerators"]!.AsArray();

	[Fact]
	public void Ids_AndTheCardsBehindThem() {
		foreach (JsonNode n in Each(Accel, "ids"))
			Assert.Equal(n["id"]!.GetValue<string>(), Core.GpuId(n["name"]!.GetValue<string>()));
		foreach (JsonNode n in Each(Accel, "isId")) {
			string id = n["id"]!.GetValue<string>();
			Assert.True(n["valid"]!.GetValue<bool>() == Core.IsId(id), id);
			Assert.Equal(n["kind"]?.GetValue<string>(), Core.KindOf(id));
		}
		foreach (JsonNode c in Each(Accel, "cards")) {
			var adapters = Each(c, "adapters").Select(a => new CardName(a["index"]!.GetValue<int>(), a["name"]!.GetValue<string>(), a["vendorId"]!.GetValue<uint>(), a["software"]!.GetValue<bool>()));
			Assert.Equal(Each(c, "keys").Select(k => k.GetValue<string>()), Core.CardKeys(adapters, c["software"]!.GetValue<bool>()).Select(k => k.Key));
		}
	}

	[Fact]
	public void ReevesConfig() {
		foreach (JsonNode c in Each(Accel, "configs"))
			Same(c["expect"], Json(Core.CallWithRules("parseAccelerators", c["raw"]!.DeepClone())), c["case"]!.GetValue<string>());
		foreach (JsonNode f in Each(Accel, "files")) {
			string file = f["file"]!.GetValue<string>();
			JsonNode? got = Json(Core.CallWithRules("readConfig", file, f["text"]?.DeepClone()));
			string? error = f["expect"]!["error"]?.GetValue<string>();
			// A file that isn't JSON: the message ends in the JSON reader's own words, which differ between engines.
			if (error != null && error.StartsWith(file + " couldn't be read: ", StringComparison.Ordinal))
				Assert.StartsWith(file + " couldn't be read: ", got!["error"]!.GetValue<string>());
			else Same(f["expect"], got, f["case"]!.GetValue<string>());
		}
	}

	[Fact]
	public void FailureMarkers_AsTheCoreReadsAndWritesThem() {
		foreach (JsonNode f in Each(Accel, "failures")) {
			string? text = f["text"]?.GetValue<string>();
			string what = f["case"]!.GetValue<string>();
			Same(f["expect"], Json(Core.CallWithRules("failureOf", text, Now)), what);
			KitFailure? typed = Core.FailureOf(text, DateTime.UnixEpoch.AddMilliseconds(Now));
			if (f["expect"] is not JsonNode want) Assert.Null(typed);
			else {
				Assert.NotNull(typed);
				Assert.Equal(want["reason"]!.GetValue<string>(), typed!.Reason);
				Assert.Equal(want["by"]!.GetValue<string>(), typed.By);
				Assert.Equal(DateTimeOffset.Parse(want["since"]!.GetValue<string>()).UtcDateTime, typed.SinceUtc, TimeSpan.FromMilliseconds(1));
				Assert.Equal(typed.SinceUtc + TimeSpan.FromMinutes(10), typed.UntilUtc);
			}
		}
		foreach (JsonNode r in Each(Accel, "reasons"))
			Assert.Equal(r["expect"]!.GetValue<string>(), Core.OneLine(r["text"]!.GetValue<string>()));
		foreach (JsonNode r in Each(Accel, "records"))
			Assert.Equal(r["expect"]!.GetValue<string>(), Core.FailureText(r["reason"]!.GetValue<string>(), r["by"]!.GetValue<string>(), DateTime.UnixEpoch.AddMilliseconds(r["nowMs"]!.GetValue<long>())));
	}

	[Fact]
	public void Games() {
		foreach (JsonNode g in Each(Accel, "games")) {
			JsonNode? got = Json(Core.CallWithRules("gameCards", g["load"]!.DeepClone(), Accelerators(g["config"]!), new JsonObject { ["self"] = g["self"]!.GetValue<int>() }));
			Same(g["expect"], got, g["case"]!.GetValue<string>());
		}
		foreach (JsonNode s in Each(Accel, "serverNames"))
			Same(s["expect"], Json(Core.Call("serverNames", Accelerators(s["config"]!))), "serverNames");
		foreach (JsonNode g in Each(Accel, "gamesStale"))
			Assert.True(g["stale"]!.GetValue<bool>() == Json(Core.CallWithRules("gamesStale", g["games"]?.DeepClone(), Now))!.GetValue<bool>(), g["case"]!.GetValue<string>());
	}

	[Fact]
	public void Candidates_AndThePick() {
		foreach (JsonNode c in Each(Accel, "candidates")) {
			var state = new JsonObject { ["failures"] = c["failures"]?.DeepClone(), ["games"] = c["games"]?.DeepClone(), ["deferredMs"] = c["deferredMs"]?.DeepClone(), ["nowMs"] = Now };
			JsonNode r = Json(Core.CallWithRules("candidates", Accelerators(c["config"]!), c["need"]!.DeepClone(), state))!;
			var plain = new JsonObject {
				["list"] = new JsonArray(r["list"]!.AsArray().Select(a => (JsonNode?)a!["id"]!.GetValue<string>()).ToArray()),
				["skipped"] = new JsonArray(r["skipped"]!.AsArray().Select(s => (JsonNode?)new JsonObject { ["id"] = s!["acc"]!["id"]!.GetValue<string>(), ["why"] = s["why"]!.GetValue<string>(), ["detail"] = s["detail"]!.GetValue<string>() }).ToArray()),
			};
			Same(c["expect"], plain, c["case"]!.GetValue<string>());
		}
		foreach (JsonNode p in Each(Accel, "pick")) {
			var wanted = Each(p, "candidates").Select(id => id.GetValue<string>()).ToHashSet();
			var list = new JsonArray(Accelerators(p["config"]!).Where(a => wanted.Contains(a!["id"]!.GetValue<string>())).Select(a => a!.DeepClone()).ToArray());
			JsonNode r = Json(Core.CallWithRules("pick", list, p["lane"]!.GetValue<string>(), p["looks"]!.DeepClone()))!;
			JsonNode plain = r["acc"] is JsonNode acc ? new JsonObject { ["acc"] = acc["id"]!.GetValue<string>() } : r;
			Same(p["expect"], plain, p["case"]!.GetValue<string>());
		}
		foreach (JsonNode w in Each(Accel, "whyNone")) {
			var skipped = new JsonArray(Each(w, "skipped").Select(s => {
				JsonObject o = s.DeepClone().AsObject();
				o["acc"] = new JsonObject { ["id"] = s["id"]!.GetValue<string>(), ["name"] = s["id"]!.GetValue<string>() };
				return (JsonNode?)o;
			}).ToArray());
			Same(w["expect"], Json(Core.Call("whyNone", skipped, w["first"]?.DeepClone())), w["case"]!.GetValue<string>());
		}
	}

	[Fact]
	public void Messages_AndTheSizeOfARequest() {
		foreach (JsonNode m in Each(Accel, "messages")) {
			Assert.Equal(m["theAccelerator"]!.GetValue<string>(), Json(Core.Call("theAccelerator", m["ref"]?.DeepClone()))!.GetValue<string>());
			Assert.Equal(m["noteLabel"]!.GetValue<string>(), Json(Core.Call("noteLabel", m["ref"]?.DeepClone()))!.GetValue<string>());
			if (m["ref"] is JsonNode r) Assert.Equal(m["theAccelerator"]!.GetValue<string>(), Core.TheAccelerator(r["id"]!.GetValue<string>(), r["name"]!.GetValue<string>()));
		}
		foreach (JsonNode t in Each(Accel, "tokens")) {
			JsonNode? got = t["text"] != null ? Json(Core.CallWithRules("estimateTokens", t["text"]!.DeepClone()))
				: t["chat"] != null ? Json(Core.CallWithRules("chatTokens", t["chat"]!.DeepClone()))
				: Json(Core.CallWithRules("visionTokens", t["vision"]!.DeepClone()));
			Assert.Equal(t["estimate"]!.GetValue<int>(), got!.GetValue<int>());
		}
		foreach (JsonNode p in Each(Accel, "pieces"))
			Same(p["expect"], Json(Core.CallWithRules("pieces", p["text"]!.DeepClone(), p["budget"]!.DeepClone())), "pieces");
	}
}
