import assert from 'node:assert/strict';
import { test } from 'node:test';

// NPU_PS (kit 2.87.0, the Envoy's speech-NPU check): only DETECT_PS' NPU lines, ending with done|. DETECT_PS itself is
// as it was: its NPU lines are shared with NPU_PS, not changed.
const { DETECT_PS, NPU_PS, parseNpus, runPowerShell } = await import('./fixture/src/kit/detect.ts');

const NPU_LINES = `  $drivers = @(Get-CimInstance -ClassName Win32_PnPSignedDriver -Filter "DeviceClass='COMPUTEACCELERATOR'")
  $npus = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "PNPClass='ComputeAccelerator'" | Sort-Object Name)
  foreach ($n in $npus) {
    $d = $drivers | Where-Object { $_.DeviceID -eq $n.PNPDeviceID } | Select-Object -First 1
    $ver = ''; $date = ''
    if ($d) { $ver = [string]$d.DriverVersion; if ($d.DriverDate) { $date = ([datetime]$d.DriverDate).ToString('yyyy-MM-dd') } }
    'npu2|' + $ver + '|' + $date + '|' + ([string]$n.Manufacturer).Replace('|', ' ') + '|' + $n.PNPDeviceID + '|' + $n.Name
  }`;

test('NPU_PS: the NPU lines alone, no Hexagon fallback, and done| once Windows has answered', () => {
  assert.equal(
    NPU_PS,
    `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
try {
${NPU_LINES}
  'done|'
} catch { 'problem|NPU: ' + $_.Exception.Message }
`,
  );
  for (const not of ['Add-Type', 'Hexagon', 'Win32_Processor', 'adapter|']) assert.ok(!NPU_PS.includes(not), not);
});

test('DETECT_PS is as it was before NPU_PS: the same NPU lines, then the Hexagon fallback and the processor', () => {
  assert.ok(DETECT_PS.startsWith("$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\ntry { [Console]::OutputEncoding"));
  assert.ok(DETECT_PS.includes(`try {\n${NPU_LINES}\n  if (-not $npus.Count) {\n    foreach ($d in @(Get-CimInstance -ClassName Win32_PnPSignedDriver -Filter "DeviceName LIKE '%Hexagon%'" | Sort-Object DeviceName)) {`));
  assert.ok(DETECT_PS.indexOf("'npu|' + $d.DriverVersion") < DETECT_PS.indexOf("'cpu|' + $p.Architecture"), 'the processor after the NPU, as noNpu reads it');
  assert.ok(!DETECT_PS.includes("'done|'"), "DETECT_PS' own output is unchanged");
});

test("NPU_PS' answer reads as DETECT_PS' NPU lines do; Windows' answer on this PC ends with done|", { skip: process.platform !== 'win32' }, async () => {
  const text = 'npu2|32.0.100.5540|2026-08-19|Intel Corporation|PCI\\VEN_8086&DEV_7D1D&SUBSYS_381717AA&REV_05\\3&11583659&0&58|Intel(R) AI Boost\r\ndone|\r\n';
  const npus = parseNpus(text, 'x64');
  assert.equal(npus.length, 1);
  assert.equal(npus[0].vendor, 'intel');
  const out = await runPowerShell(NPU_PS);
  assert.match(out, /^(done\||problem\|NPU: )/m, out);
});
