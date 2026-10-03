// The Steward's kit, its dotnet part: the kit's core (the core part's JavaScript) run in Jint, a JavaScript
// interpreter written in C# (no native code, so it runs wherever .NET does: Arm64, a Store package, a
// self-contained or single-file exe). Every rule is the core's; this file only carries values in and out,
// as JSON text, so nothing here needs reflection (trimming and AOT leave it alone).
// The core's modules and the spec's rules.json are embedded resources (Steward.Kit.props).

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jint;
using Jint.Native;
using Jint.Runtime.Modules;

namespace Steward.Kit {
	/// <summary>
	/// The kit's core, hosted once per process (<see cref="Shared"/>). Thread-safe: one call at a time runs in
	/// the engine, and each takes microseconds. Values cross as JSON text.
	/// </summary>
	public sealed class KitCore {
		static readonly Lazy<KitCore> shared = new(() => new KitCore());

		/// <summary>The core, loaded on first use (about 100 ms, once).</summary>
		public static KitCore Shared => shared.Value;

		readonly object gate = new();
		readonly Engine engine;
		readonly JsValue callFn, callRulesFn, sayFn;

		/// <summary>spec/rules.json, as the core checked it.</summary>
		public KitRules Rules { get; }

		/// <summary>The kit's version this part came with (its VERSION when embedded, else "").</summary>
		public string Version { get; }

		KitCore() {
			engine = new Engine(o => o.Strict().EnableModules(new ResourceLoader()));
			var bridge = engine.Modules.Import(ResourceLoader.Bridge);
			callFn = bridge.Get("call");
			callRulesFn = bridge.Get("callRules");
			sayFn = bridge.Get("say");
			string rules = engine.Invoke(bridge.Get("init"), (JsValue)ResourceLoader.Read("spec/rules.json")).AsString();
			Rules = KitRules.Parse(rules);
			Version = ResourceLoader.TryRead("VERSION")?.Trim() ?? "";
		}

		/// <summary>Calls the core's <paramref name="function"/> with these arguments (JSON values); its answer as JSON text.</summary>
		public string Call(string function, params JsonNode?[] args) => Invoke(callFn, function, args);

		/// <summary>Calls a core function that takes the rules first (rules.json's, checked) with these arguments after them.</summary>
		public string CallWithRules(string function, params JsonNode?[] args) => Invoke(callRulesFn, function, args);

		/// <summary>One of the core's messages (its <c>say</c>), in its words.</summary>
		public string Say(string message, params JsonNode?[] args) => JsonNode.Parse(Invoke(sayFn, message, args))!.GetValue<string>();

		string Invoke(JsValue fn, string name, JsonNode?[] args) {
			string argsJson = new JsonArray(args.Select(a => a?.DeepClone()).ToArray()).ToJsonString();
			lock (gate) {
				try {
					return engine.Invoke(fn, (JsValue)name, (JsValue)argsJson).AsString();
				}
				catch (Jint.Runtime.JavaScriptException e) {
					throw new InvalidOperationException($"the kit's core ({name}): {e.Message}", e);
				}
			}
		}

		JsonNode? Node(string json) => JsonNode.Parse(json);

		// ------------------------------------------------------------ ids

		/// <summary>A name as the ids have it: lowercase, each run of other characters one dash, none at either end.</summary>
		public string Slug(string name) => Node(Call("slug", name))!.GetValue<string>();

		/// <summary><c>npu</c>, <c>cpu</c>, or <c>gpu-</c> and the slug of the card's name (<c>gpu-graphics-card</c> when that's empty).</summary>
		public string AcceleratorId(string kind, string name) => Node(Call("acceleratorId", kind, name))!.GetValue<string>();

		/// <summary>A graphics card's id from its name (its key: "NVIDIA GeForce RTX 4090 #2").</summary>
		public string GpuId(string cardName) => AcceleratorId("gpu", cardName);

		/// <summary>Whether it is an accelerator id: npu, cpu or gpu-… (nothing that could name another folder).</summary>
		public bool IsId(string? id) => id != null && Node(Call("isId", id))!.GetValue<bool>();

		/// <summary>"npu", "gpu" or "cpu": the kind an id names; null when it isn't an id.</summary>
		public string? KindOf(string? id) => id == null ? null : Node(Call("kindOfId", id))?.GetValue<string>();

		/// <summary>
		/// The graphics cards as every program names them: Windows' software adapters left out (unless
		/// <paramref name="software"/>), a nameless one "Graphics card n" (its index plus one), a second card of a name
		/// "name #2", in DXGI's order. Each card kept: its index, its name (trimmed), and its key (the name, or "name #2").
		/// </summary>
		public IReadOnlyList<(int Index, string Name, string Key)> CardKeys(IEnumerable<CardName> adapters, bool software = false) {
			var list = new JsonArray();
			foreach (CardName a in adapters)
				list.Add((JsonNode)new JsonObject { ["index"] = a.Index, ["name"] = a.Name ?? "", ["vendorId"] = a.VendorId, ["software"] = a.Software });
			JsonArray keyed = Node(Call("keyedCards", list, new JsonObject { ["software"] = software }))!.AsArray();
			return keyed.Select(k => (k!["index"]!.GetValue<int>(), k["name"]!.GetValue<string>(), k["key"]!.GetValue<string>())).ToList();
		}

		/// <summary>An accelerator's lock folders, one per slot (the NPU always one): <c>id</c>, <c>id.2</c> ….</summary>
		public IReadOnlyList<string> LockFolders(string id, int slots = 1) =>
			Node(Call("lockFoldersOf", new JsonObject { ["id"] = id, ["slots"] = slots }))!.AsArray().Select(n => n!.GetValue<string>()).ToList();

		/// <summary>The line's folder beside a lock folder: <c>&lt;folder&gt;.queue</c>.</summary>
		public string QueueName(string folder) => Node(Call("queueName", folder))!.GetValue<string>();

		// ------------------------------------------------------------ tickets

		/// <summary>A ticket from its file name, or null for anything that isn't one.</summary>
		public QueueTicket? ParseTicket(string name) {
			JsonNode? t = Node(Call("parseTicket", name));
			return t == null ? null : new QueueTicket(t["name"]!.GetValue<string>(), t["lane"]!.GetValue<int>(), t["timeUs"]!.GetValue<long>(), t["pid"]!.GetValue<int>(), t["nonce"]!.GetValue<string>());
		}

		/// <summary>The order of the line: interactive first, then by arrival; background that waited long enough counts as interactive.</summary>
		public int CompareTickets(QueueTicket a, QueueTicket b, long nowUs) =>
			Node(CallWithRules("compareTickets", a.ToJson(), b.ToJson(), nowUs))!.GetValue<int>() switch { < 0 => -1, > 0 => 1, _ => 0 };

		/// <summary>Whether a ticket's waiter is gone: no heartbeat for too long, or a late one and no such process (asked only then).</summary>
		public bool IsDeadTicket(TimeSpan age, Func<bool> pidAlive) {
			string state = Node(CallWithRules("ticketState", (long)age.TotalMilliseconds))!.GetValue<string>();
			return state == "dead" || state == "late" && !pidAlive();
		}

		// ------------------------------------------------------------ failure markers

		/// <summary>
		/// A failure marker's contents (null when there's no file) while it counts; null when it's absent, unreadable (which
		/// counts the same) or expired (exactly rules' failedForMs old has expired).
		/// </summary>
		public KitFailure? FailureOf(string? text, DateTime nowUtc) {
			JsonNode? f = Node(CallWithRules("failureOf", text, Ms(nowUtc)));
			if (f == null) return null;
			long since = (long)Node(Call("parseIsoMs", f["since"]!.GetValue<string>()))!.GetValue<double>();
			return new KitFailure(DateTime.UnixEpoch.AddMilliseconds(since), f["reason"]!.GetValue<string>(), f["by"]!.GetValue<string>(), Rules.FailedFor);
		}

		/// <summary>A new marker's text, as every program writes it: <c>{ "since", "reason", "by" }</c>, the reason one line.</summary>
		public string FailureText(string? reason, string by, DateTime nowUtc) =>
			Node(Call("sharedText", Node(CallWithRules("failureRecord", reason ?? "", by, Ms(nowUtc)))))!.GetValue<string>();

		/// <summary>A reason as a marker keeps it: the first line, trimmed, at most rules' reasonMaxChars ("it failed" when empty).</summary>
		public string OneLine(string? text) => Node(CallWithRules("oneLine", text ?? ""))!.GetValue<string>();

		// ------------------------------------------------------------ messages

		/// <summary>"the NPU", "the NVIDIA GeForce RTX 4090", "the graphics card": an accelerator in a sentence.</summary>
		public string TheAccelerator(string id, string name) => Node(Call("theAccelerator", new JsonObject { ["id"] = id, ["name"] = name }))!.GetValue<string>();

		// ------------------------------------------------------------ the turn

		internal TurnStep StartTurn(JsonObject options) => TurnStep.From(CallWithRules("startTurn", options));
		internal TurnStep StartLock(JsonObject options) => TurnStep.From(CallWithRules("startLock", options));
		internal TurnStep Step(TurnStep last, long nowMs, JsonArray results) =>
			TurnStep.From(Call("step", Node(last.StateJson), new JsonObject { ["nowMs"] = nowMs, ["results"] = results }));
		internal TurnStep Release(TurnStep held, long nowMs) => TurnStep.From(Call("release", Node(held.StateJson), nowMs));
		internal TurnStep Abort(TurnStep last) => TurnStep.From(Call("abort", Node(last.StateJson)));

		internal static long Ms(DateTime utc) => (long)(utc.ToUniversalTime() - DateTime.UnixEpoch).TotalMilliseconds;

		/// <summary>Serves the core's modules and rules.json from this assembly's resources, and the bridge from here.</summary>
		sealed class ResourceLoader : ModuleLoader {
			internal const string Bridge = "/steward-kit/bridge.js";
			const string Prefix = "Steward.Kit/";

			/// <summary>The JavaScript side of <see cref="KitCore"/>: JSON in, the core's answer as JSON out.</summary>
			const string BridgeCode = """
				import * as core from '/core/index.js';
				let rules = null;
				export function init(text) {
				  rules = core.checkRules(JSON.parse(text.replace(/^﻿/, '')));
				  return JSON.stringify(rules);
				}
				function fn(name) {
				  const f = core[name];
				  if (typeof f !== 'function') throw new Error(`the core has no function ${name}`);
				  return f;
				}
				const out = (v) => (v === undefined ? 'null' : JSON.stringify(v));
				export function call(name, args) { return out(fn(name)(...JSON.parse(args))); }
				export function callRules(name, args) { return out(fn(name)(rules, ...JSON.parse(args))); }
				export function say(name, args) {
				  const f = core.say[name];
				  if (typeof f !== 'function') throw new Error(`the core has no message ${name}`);
				  return out(f(...JSON.parse(args)));
				}
				""";

			public override ResolvedSpecifier Resolve(string? referencingModuleLocation, ModuleRequest moduleRequest) {
				string spec = moduleRequest.Specifier;
				string key = spec.StartsWith("./", StringComparison.Ordinal) && referencingModuleLocation is { } from
					? from[..(from.LastIndexOf('/') + 1)] + spec[2..]
					: spec;
				return new ResolvedSpecifier(moduleRequest, key, null, SpecifierType.RelativeOrAbsolute);
			}

			protected override string LoadModuleContents(Engine engine, ResolvedSpecifier resolved) =>
				resolved.Key == Bridge ? BridgeCode : Read(resolved.Key.TrimStart('/'));

			internal static string Read(string name) =>
				TryRead(name) ?? throw new FileNotFoundException($"The kit's {name} isn't embedded in {typeof(KitCore).Assembly.GetName().Name}: import Steward.Kit.props, which embeds the core and the spec's rules.json.");

			internal static string? TryRead(string name) {
				using Stream? s = typeof(KitCore).Assembly.GetManifestResourceStream(Prefix + name);
				if (s == null) return null;
				using var r = new StreamReader(s);
				return r.ReadToEnd();
			}
		}
	}

	/// <summary>One adapter as DXGI describes it, as much of it as the cards' names need.</summary>
	public readonly record struct CardName(int Index, string Name, uint VendorId, bool Software);

	/// <summary>A waiter's ticket, from its file name <c>&lt;lane&gt;-&lt;time&gt;-&lt;pid&gt;-&lt;nonce&gt;.ticket</c>.</summary>
	/// <param name="Lane">0 interactive, 1 background.</param>
	/// <param name="TimeUs">When it joined, in microseconds since the Unix epoch.</param>
	public sealed record QueueTicket(string Name, int Lane, long TimeUs, int Pid, string Nonce) {
		internal JsonObject ToJson() => new() { ["name"] = Name, ["lane"] = Lane, ["timeUs"] = TimeUs, ["pid"] = Pid, ["nonce"] = Nonce };
	}

	/// <summary>A failure marker that still counts: when it was written, why, by whom, and when it stops counting.</summary>
	public sealed record KitFailure(DateTime SinceUtc, string Reason, string By, TimeSpan FailedFor) {
		/// <summary>When it stops counting.</summary>
		public DateTime UntilUtc => SinceUtc + FailedFor;
	}

	/// <summary>spec/rules.json's timings and limits, as the core checked them.</summary>
	public sealed class KitRules {
		/// <summary>The checked rules as JSON text.</summary>
		public string Json { get; }
		readonly JsonNode root;

		KitRules(string json) {
			Json = json;
			root = JsonNode.Parse(json)!;
		}

		internal static KitRules Parse(string json) => new(json);

		/// <summary>A value by section and name ("queue", "deadMs").</summary>
		public long Value(string section, string name) => root[section]?[name]?.GetValue<long>() ?? throw new KeyNotFoundException($"rules.json has no {section}.{name}");

		TimeSpan Ms(string section, string name) => TimeSpan.FromMilliseconds(Value(section, name));

		public TimeSpan Heartbeat => Ms("queue", "heartbeatMs");
		public TimeSpan Late => Ms("queue", "lateMs");
		public TimeSpan Dead => Ms("queue", "deadMs");
		public TimeSpan Age => Ms("queue", "ageMs");
		public TimeSpan Wait => Ms("lock", "waitMs");
		public TimeSpan Stale => Ms("lock", "staleMs");
		public TimeSpan FailedFor => Ms("accelerators", "failedForMs");
		public int ReasonMaxChars => (int)Value("accelerators", "reasonMaxChars");
	}

	/// <summary>One step of the core's turn machine: its state (the core's, carried), what to do, how long to wait, and how it ended.</summary>
	public sealed class TurnStep {
		/// <summary>The machine's state, as JSON text: the core's own, which a driver only carries.</summary>
		public string StateJson { get; }
		/// <summary>What to do now, in order.</summary>
		public JsonArray Actions { get; }
		/// <summary>How long to wait after them, in milliseconds.</summary>
		public int WaitMs { get; }
		/// <summary>How the machine ended, or null while it goes on.</summary>
		public JsonObject? Done { get; }

		TurnStep(string state, JsonArray actions, int waitMs, JsonObject? done) {
			StateJson = state;
			Actions = actions;
			WaitMs = waitMs;
			Done = done;
		}

		internal static TurnStep From(string json) {
			JsonObject o = JsonNode.Parse(json)!.AsObject();
			return new TurnStep(o["state"]!.ToJsonString(), o["actions"]!.AsArray(), (int)(o["waitMs"]?.GetValue<double>() ?? 0), o["done"]?.AsObject());
		}
	}
}
