// What the dotnet part does in a published exe: the core loads from the exe's own resources, answers, and a
// turn on a scratch lock goes through. Prints one line a check, and exits 1 when any fails.
using System.Diagnostics;
using Steward.Kit;

int failed = 0;
void Check(string what, bool ok, string detail = "") {
	Console.WriteLine($"{(ok ? "ok  " : "FAIL")} {what}{(detail.Length > 0 ? ": " + detail : "")}");
	if (!ok) failed++;
}

var sw = Stopwatch.StartNew();
KitCore core = KitCore.Shared;
Check("the core loads", core.Rules.Dead == TimeSpan.FromSeconds(15), $"{sw.ElapsedMilliseconds} ms, kit {core.Version}, rules.json's dead {core.Rules.Dead.TotalSeconds} s");
Check("ids", core.GpuId("NVIDIA GeForce RTX 4090 #2") == "gpu-nvidia-geforce-rtx-4090-2" && core.IsId("npu") && !core.IsId("..\npu"));
string marker = core.FailureText("DirectML failed\nmore", "check", new DateTime(2026, 10, 2, 12, 0, 0, DateTimeKind.Utc));
Check("a failure marker", marker.Contains("\"since\": \"2026-10-02T12:00:00.000Z\"") && marker.Contains("\"reason\": \"DirectML failed\""));

string root = Path.Combine(Path.GetTempPath(), "kit-publish-check-" + Guid.NewGuid().ToString("N"));
try {
	string npu = Path.Combine(root, "locks", "npu");
	sw.Restart();
	using (HeldLock held = AcceleratorLock.Acquire(npu, new TurnOptions { Who = "publish-check" }))
		Check("a turn", File.Exists(Path.Combine(npu, "owner.json")), $"{sw.ElapsedMilliseconds} ms");
	Check("the release", !Directory.Exists(npu));
	sw.Restart();
	for (int i = 0; i < 20; i++) using (AcceleratorLock.Acquire(npu)) { }
	Check("20 more turns", true, $"{sw.ElapsedMilliseconds / 20.0:0.0} ms each");
}
catch (Exception e) {
	Check("turns", false, e.ToString());
}
finally {
	try { Directory.Delete(root, true); } catch { }
}
Console.WriteLine($"{System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture}, {(File.Exists(Path.Combine(AppContext.BaseDirectory, "Jint.dll")) ? "files" : "single file")}");
return failed == 0 ? 0 : 1;
