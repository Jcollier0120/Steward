# The kit's changelog

Each version of the Steward's kit, newest first. A version is released as `kit-v<version>` (tools/kit-release.ts), and each agent takes it by pinning it in its `kit.json`. An entry says what an agent's maintainer needs to know: what changed, and anything the agent must do.

## 1.2.1

**A wording fix in Where its work runs.** Its Task Manager line said "Performance, NPU: it isn't…". The Aletaster's page test forbids "NPU:" anywhere on its page, from when the NPU was the only accelerator, so its 1.2.0 bump failed and was held back. The line now reads "on a graph of its own (Performance, then NPU)". A kit test checks that no agent's section says "NPU:" or "NPU note". Nothing for an agent to do.

## 1.2.0

**Where its work runs**, at the end of every kit agent's Settings page. It says what the agent does, where it runs (the processor, a graphics card's encoder, the network, Reeve's model) and when, so someone who sees the processor or a graphics card busy for a minute can tell why. node/work.ts is new:
- **`WORK`** holds each kit agent's lines, by its id: the eight hires, the Steward and the Surveyor. An agent not listed shows the shared part only. A change to what an agent does is a change here.
- **The shared part** says how model requests take turns (one at a time on the NPU, shared with every agent), Reeve's order, and that background work keeps off a graphics card a game is using. It names the accelerators this PC actually has, read from Reeve's config.json as every request reads it: "On this PC, Reeve lists the NPU (chat, vision). So its model work runs on the NPU only, never on the processor or a graphics card." It also says that Task Manager shows the NPU's work under its own graph.
- **page.ts** adds the section to every page, marked `data-settings-extra`. The Settings page takes it after the agent's own Settings section, and that section now stops before it. Without JavaScript, it stays at the end of the page.
- **Nothing for an agent to do.**

## 1.1.0

**Settings is a page of its own**, as on Manor's, Reeve's and Heiward's, so an agent's page is no longer as tall as its settings. page.ts:
- **The header** has a Settings link with a gear, on the right. It opens Settings at `#/settings` (`#settings` too), and the Settings page's back link returns.
- **The Settings page** is the section the agent's body already has: page.ts's script lifts it out of the page. The section runs from the panel back to the heading before it, when that heading says Settings, and on to the next heading. That takes the agent's own Settings cards with it (Clerk's folders, Warrener's locations, Miller's hopper, Aletaster's projects) and the version line, and leaves every other section on the main page.
- **The page doesn't refresh itself while Settings is open,** as it doesn't while something is ticked or being typed in.
- **Without JavaScript** (which the panel needs anyway), the page is as before, and the link stays hidden.
- **Nothing for an agent to do.** Its view.ts keeps writing its Settings section where it always did. Checked against all nine kit agents' real pages.

## 1.0.0

The kit's first version: the files the eight hires (Porter, Auditor, Clerk, Herald, Warrener, Aletaster, Miller, Pinder) each carried as an identical copy, as of their release-0.3.1, kept once here. tools/kit-from.ts found them by comparing the hires; the seed commit has them as they were, only moved.

**Where it lives in an agent.** An agent no longer carries the kit's code. Its `kit.json` pins a version and the parts it takes, `{"kit": "1.0.0", "parts": ["node", "web", "spec"]}`, and its `tools/kit.ts` fills `src/kit/` (git-ignored) from a kit release; a release of the agent carries `src/kit/`.
- **node**, at `src/kit/`: accelerators.ts, duty.ts, gpu-load.ps1, install.ts, lock.ts, npu-queue.ts, npu.ts, page.ts, ps.ts, release.ts (was tools/release.ts), schedule.ts, server.ts, service.ts, settings-kit.ts, store.ts, and agent-checks.ts (new). An agent imports `./kit/npu.ts` where it imported `./npu.ts`.
- **web**, at `src/kit/web/`: settings-panel.js, and settings-panel.css (new).
- **spec**, at `src/kit/spec/`: npu-queue-vectors.json (was test/), NPU-QUEUE.md (was Reeve's docs/NPU-QUEUE.md) and ACCELERATORS.md (was Manor's docs/ACCELERATORS.md). This is now their home; each says so. The kit's npu-queue.ts is now the original of the NPU queue, and Reeve's src/npu-queue.ts its copy.
- The kit reaches the agent's own code through two fixed paths, `src/app.ts` and `src/settings.ts` (the agent interface, in the Steward's README).

**Changes over the hires' copies:**
- settings-kit.ts and settings-panel.js are Manor's newer copy. `SettingsSpec` takes an optional `usedFrom`, the panel's first line saying when a saved change is used ("from the next round on" when it's left out, as before). Backwards compatible.
- Reeve not set up reads the same in each case: no config.json (Reeve writes none on a PC without an NPU), an empty `accelerators` list (Reeve's setup dropped the install's `npu` entry), or a list where nothing serves anything. The message is "Reeve isn't set up here: open Reeve's page, Settings → Set up (or run `reeve accelerators setup`)" (`REEVE_NOT_SET_UP` in accelerators.ts), without the config's path, and an agent's `npu.problem` says it. A list whose entries can't be read is named as such ("lists no accelerator that can be used (…)"). A config that serves some kinds but not the one asked for (no vision, say) keeps its message naming the kind. Like every message of the kit's model code, it has no full stop of its own: an agent ends its sentence as it always has ("No notes: ….", or none), so none shows two.
- The Settings panel's styles moved out of page.ts's CSS into web/settings-panel.css; page.ts links it as `/settings.css`, and server.ts serves it beside `/settings.js`, from the web part. An agent without the web part has no panel (both answer 404). `button.link` and `button.small` stay in page.ts, for every page.
- release.ts (src/kit/release.ts) finds the agent's root above src/kit, refuses to build unless `src/kit/VERSION` is the version `kit.json` pins, and writes `"kit": "<version>"` into release.json and the release notes. A release also carries `kit.json` and `tools/kit.ts` (a change to either makes it dirty), so an unpacked release can fill its kit again, and the installed Steward has the tools/kit.ts it hands out. install.ts's `Release` has the optional `kit`.
- tools/kit.ts, the one file each agent keeps, is the Steward's: `steward bump` copies it into each agent with the new pin, so a change to it is released and rolled out as a kit version.
- agent-checks.ts is new: the kit's checks of the agent it is in (its package.json and src/app.ts agree, src/kit is the pinned kit, it has art/icon.svg, and its settings schema, defaults and normalize agree, as each hire's settings-kit.test.ts checked). An agent runs them from one line, `test/agent.test.ts`: `import '../src/kit/agent-checks.ts';`.
- The kit's own tests (accelerators, npu-queue, kit, install, settings-kit) run in the Steward against a fixture agent, kit\test\fixture, and no longer in each agent. test/kit.test.ts and test/npu-queue.test.ts, the same in every hire but for its name, are among them.
