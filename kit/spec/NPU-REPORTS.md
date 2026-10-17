# NPU reports

How each NPU really does comes from the PCs it runs on, sent by their owners when they say so, rather than from the
owner's own laptops alone. Setup measures every NPU it sets up and keeps what it found on the PC; Manor offers to send
it; the Exchequer keeps and counts the reports; and a command here turns the counts into the change to
`npu-vendors.json` that a person reviews and releases. The owner decided it on 2026-10-16: reports go without a
license or token, setup measures every NPU, a generation is verified from 3 PCs with under 1 in 5 failing, and the site
shows the measured speeds once the kit carries them.

## What a report says

One JSON object, `castellan-npu-report/1`, its schema beside this file (`npu-report.schema.json`). An example:

```json
{
  "format": "castellan-npu-report/1",
  "reporter": "0b6c3f6e-2f4e-4f7e-9a51-6c1d2f0e8a11",
  "day": "2026-10-16",
  "source": "setup",
  "kit": "2.78.0",
  "app": "manor 0.16.200",
  "chip": { "vendor": "intel", "generation": "lunar-lake", "pciDevice": "643E", "cpu": "Intel(R) Core(TM) Ultra 7 256V",
            "npu": "Intel(R) AI Boost", "driver": "32.0.100.4512", "driverDate": "2026-08-01", "arch": "x64",
            "ramGb": 32, "windows": "26200" },
  "route": { "server": "OpenVINO Model Server", "version": "2026.4.1",
             "model": "Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov", "cap": 4096, "verified": true },
  "ok": true,
  "failed": null,
  "speeds": { "coldMs": 41200, "warmMs": 720, "tokensPerSecond": 25.1, "readTokens": 1004, "readMs": 830 }
}
```

- **reporter**: a random id made for these reports alone (`npu-reporter.json` beside the report), so several reports from
  one PC count as one PC. It is not the device id Manor gives the Exchequer, nor anything of the license's.
- **day**: the day only.
- **source**: `setup` (every setup that set the NPU up, or found it can't) or `npu-check` (the NPU check's run, which
  measures more).
- **chip**: what detection found: the maker and npu-vendors.json's generation (`unknown` for one setup doesn't know,
  with its `pciDevice`: that is how a new PCI id is found), the processor's and the NPU's names as Windows gives them,
  the NPU's driver and its date, the processor's architecture, the memory in whole GB, and Windows' build number.
- **route**: the server, its version, the chat model, the prompt cap it ran with, and whether its generation was
  `verified` then. Null when nothing was set up (an NPU the manor can't use).
- **ok**: every step passed. **failed**: the step that didn't, as a code, never setup's own words (they can hold a
  path, and so a user name):

  | Code | Setup's step |
  |---|---|
  | `not-supported` | The NPU's maker, generation or Windows isn't one setup can use |
  | `driver` | Its driver is older than the route needs |
  | `memory` | The PC hasn't the memory for the chat model beside everything else |
  | `download`, `install`, `runtime`, `pull`, `checksum` | The server, its runtime or its model couldn't be had whole |
  | `test-timeout`, `test-nonsense`, `test` | The test request: out of time, nonsense, or another failure |
  | `measure`, `too-slow` | The measuring requests failed, or it wrote under 2 tokens a second |
  | `embed` | Its own embedding server failed (the chat model is used all the same) |

  The NPU check's are its step names (`start`, `first-answer`, `warm`, `speed`, `read`, `cap`, `two-at-once`,
  `restart`, `kit-test`, `embed`…).
- **speeds** (null where not measured):
  - `coldMs`: from the server's start to the test's answers (a picture's too, where it serves vision), a first compile
    included where the server compiles its model for this NPU. Null when the server was already running.
  - `warmMs`: a short answer ("ready"), the model loaded.
  - `tokensPerSecond`: writing, from a count to twenty (setup) or a hundred (the NPU check), over the server's own token
    count where it gives one.
  - `readTokens`, `readMs`: a prompt of about 1,000 tokens (setup; the NPU check's is 80% of the cap) read and answered
    in four tokens: the time to read it.

Nothing else: no license, token, device id, PC or user name, path, laptop make or model, prompt or answer. A report is
small (under 2 KB) and the Exchequer refuses one that doesn't match the schema.

## On the PC

Setup (`setupCommand`) writes the report whenever it set the NPU up or found it can't (`npu-report.json` beside
`npu-note.json`, in the accelerators folder), overwriting the last; a setup that leaves a configured NPU alone writes
none. It measures every NPU it sets up, verified or not (`measureNpu`: the warm answer, the count, the read; about 3
to 15 s in the NPU's turn); only a generation still unverified is calibrated from it, and only there does a failed or
too-slow measurement keep the NPU out. On a verified one it is reported and the NPU is used as before.

The NPU check (`npu-check.ts`) writes the same report from its own steps when it ran on the NPU (not a rehearsal,
`--harden` or `--idle`).

`npu-report.ts`: `npuReportFile()`, `readNpuReport()`, `rememberNpuReport()`, `reporterId()`, `npuReportFromSetup()`,
`npuReportFromCheck()`, `checkNpuReport()` (the schema), `npuReportKey()` (what makes two reports the same, for "offer
it once").

Sending is the app's, and only on its owner's word (Manor: after setup, and from Settings, showing the report as it will
be sent). Nothing in the kit sends it.

## At the Exchequer

`POST /api/v1/npu-reports` with the report as its body: no token, refused unless it matches the schema, a few a day per
reporter and per address (the address hashed, and forgotten after a day). The reports are kept two years.

`GET /api/v1/admin/npu-reports/summary` (the publisher's key) counts them, `castellan-npu-summary/1`:

```json
{
  "format": "castellan-npu-summary/1",
  "at": "2026-11-02T09:00:00.000Z",
  "groups": [
    {
      "vendor": "intel", "generation": "meteor-lake", "pciDevice": null,
      "server": "OpenVINO Model Server", "version": "2026.4.1", "model": "Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov",
      "reports": 7, "pcs": 5, "passedPcs": 4, "failedPcs": 1, "failures": { "test-timeout": 1 },
      "drivers": ["32.0.100.3104", "32.0.100.4512"], "cpus": ["Intel(R) Core(TM) Ultra 7 155H"],
      "firstDay": "2026-10-20", "lastDay": "2026-11-02",
      "speeds": {
        "tokensPerSecond": { "pcs": 4, "median": 12.3, "slow": 9.1 },
        "coldMs": { "pcs": 4, "median": 95000, "slow": 140000 },
        "warmMs": { "pcs": 4, "median": 1400, "slow": 2100 },
        "readMsPer1k": { "pcs": 4, "median": 5200, "slow": 7400 }
      }
    }
  ]
}
```

- A **group** is one chip (maker and generation; for `unknown`, the PCI id too) on one route (server, version, model).
  A report without a route (`not-supported`, `driver`, `memory`) is grouped with a null server, version and model.
- A **PC** counts once per group, by its latest report there (not one marked rejected): it **passed** when that report
  is `ok`, **failed** otherwise. `failures` counts the failed PCs by step.
- **speeds** come from the passed PCs' latest reports: the median, and the slow end (the 90th percentile of times, the
  10th of writing speed), each over the PCs that measured it, and null when none did. `readMsPer1k` is `readMs` per
  1,000 `readTokens`.
- `drivers` are the distinct drivers seen, lowest first; `cpus` the distinct processor names, most reported first, at
  most 10.

A report can be marked `rejected` (`POST /api/v1/admin/npu-reports/<id>` `{ "status": "rejected" }`) and then counts for
nothing; `accepted` and `new` both count. `npm run npu-reports` in the Exchequer prints the summary.

## Into npu-vendors.json

```
node <agent>\src\kit\npu-reports.ts <summary.json>
node <agent>\src\kit\npu-reports.ts --fetch [--exchequer <url>]    (the publisher's key: EXCHEQUER_PUBLISHER_KEY, or ~/.steward/exchequer-publisher.key)
```

It reads the summary against this kit's `npu-vendors.json` and prints, per generation, what the reports say and the JSON
merge patch they support, as the NPU check prints its `patch`. It changes nothing: a person reads it, merges it into
`npu-vendors.json` and releases the kit. Only groups on the route's current server version and model count. A PC with
little memory that runs its generation's `smallPc` models in the route's place (a 16 GB Snapdragon X2's Qwen3-VL-2B)
reports those models: their groups are listed on their own (`smallPc`), for a person to read, and never count toward
the route's model.

- **verified**: a generation still `verified: false` becomes `true` once at least **3** PCs passed (`passedPcs`) and
  under **1 in 5** of its PCs failed. Short of that it says what is missing; with more failing, it lists the failures.
- **timeouts** from the slow end, by calibrate's formulas and bounds (CALIBRATION): `requestPerTokenMs` twice the slow
  writing speed's time a token, `requestBaseMs` twice a full-cap read at the slow reading time plus the slow warm answer,
  `coldLoadMs` half again the slow cold start. Never below the generation's values now. On a verified generation they
  are proposed only where its PCs need more than it has.
- **basis**: "Measured on 4 PCs by their owners' reports (…), NPU drivers … to …, 2026-10-20 to 2026-11-02: …".
- **measured**, for the site, on every generation with 3 PCs passed: `{ "pcs", "server", "model", "tokensPerSecond",
  "coldStartS", "at" }`, the medians, on the server and model they were measured with. The site shows it only while it
  names the route's current server and model.
- **Unknown PCI ids** reported from 2 PCs or more: the line to add to `devices`, once the generation is known.

## The website

`npm run sync:npus` in the site takes each generation's `verified` and `measured` from here, and its NPU page shows a
generation's measured speed ("checked on 4 PCs: about 12 tokens a second") only from `measured`. Nothing else on the
page comes from the reports.
