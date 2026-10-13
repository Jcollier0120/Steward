# Reports from customers

How a customer tells us something isn't working (an agent, setup, or a local model's answers), in a fixed format that a program can read, and how those reports become fixes. It's a draft for review (2026-10-12); nothing is built yet.

Castellan can't test every PC. One Intel laptop (Lunar Lake) is the only Intel hardware we'll have: Meteor Lake, Arrow Lake, Panther Lake and the rest will be tested by the customers who own them. So reports have to carry enough about the PC that one report, or twenty alike, says what to fix, without anyone having to ask a follow-up question.

## What's there today

Nothing sends anything back. Reeve's `ai-use --report` prints counts for a person to paste into an email to support@castellan-software.com; Heiward's old window copies diagnostics for a GitHub issue. Every automatic call goes to the Exchequer for licensing and updates only. The privacy notice (castellan-software.com/privacy) and Manor's Ask box ("nothing you ask leaves the PC") promise as much, and Manor's release checklist says the notice changes **first** whenever something new is sent.

So reports are always the person's choice, every time: shown in full before they're sent, never sent by themselves.

## Three kinds of report

1. **Report a problem.** A link on every agent's page and in Manor ("Something not working? Tell us"). The person picks what it's about (setup, an agent, the local AI, something else), says what happened in their own words if they like, and sees exactly what will be sent.
2. **"This answer is wrong"**, beside every local model's answer. Every agent's answer already carries the kit's label ("Written by a local model… check it"), from one place, `page.ts`'s `unverified()`; Manor's Ask box and repairs show their own. One click opens a short form: what was wrong (made up, wrong, nonsense, ignored the instructions, too slow), and a comment if they like. The question and answer are **not** included unless the person ticks "include the question and answer", which shows them first.
3. **Help other PCs like yours.** When setup can't use the NPU, when the NPU check fails, or after the benchmark runs, the page offers to send its report: the NPU check's and the benchmark's reports already say nothing about the person or the PC, and they are exactly what we need from a generation we've never run.

## The format: `castellan-report/1`

One JSON document, its schema beside this page (`report.schema.json`, to come):

- **report**: a new random id, when, and the kind: `problem`, `answer`, `compatibility`.
- **product**: the app and its version, the kit version, the agent the report came from.
- **pc**: as the benchmark's report has it: the processor and chip generation, the NPU and its PCI device, driver and date, graphics cards with their memory and drivers, RAM, the Windows build, and the laptop's make and model. Never the PC's or the person's name.
- **local AI**: each accelerator in config.json as setup wrote it (server and version, model ids, caps, timeouts, quirks), with paths shortened to `%USERPROFILE%`; any failure marker (`<id>.failed.json`) and its reason.
- **problem**: where it happened (the agent, the page), what (one of a fixed list for each kind, so reports can be counted), and the person's own words (2,000 characters at most).
- **attachments**, by kind: the NPU check's report, the benchmark's report, setup's last plan and problems, the last 200 lines of the agent's log, a model answer (question, answer, model, device and timing) when the person included it.
- **consent**: what the person agreed to include.

Before it's shown, and again before it's sent, the report is **cleaned**: paths under the user's folder become `%USERPROFILE%\…`, and the PC's name, the user's name, email addresses and anything shaped like a key or token are replaced with what they were (`[email]`, `[token]`). The person sees the cleaned report, so what they agree to is what's sent.

## Where it goes

- **From the PC**: Manor sends it, so agents need no network code. `POST https://api.castellan-software.com/api/v1/reports`, with the PC's own token, as the hourly licence check uses (a PC on a trial or without a licence sends it without, and is held to a tighter limit). If it can't be sent (offline, or the Exchequer says no), it is kept, and the page offers to save it as a file, for an email to support@castellan-software.com.
- **In the Exchequer**: a new `reports` handler beside `license`: the PC's token checked as for the licence, the size capped (256 KB), a limit of 20 a day a PC (and fewer without a token), stored in a new table `exchequer.reports` (row-level security on, no policies, as every table is), kept 180 days and then pruned with the rest. Bigger attachments go to the private R2 bucket, not the 500 MB database.
- **The inbox**: `GET /api/v1/reports?since=…`, with the publisher's key, as releases use. A Steward command (`npm run reports`) reads it into a local queue.

## From a report to a fix

**Reports are grouped by what they have in common** (kind, chip generation, driver, server and model, the failed step or the kind of error), so twenty Meteor Lake PCs failing the same way are one item with a count of twenty, not twenty items. Each group carries every report's facts, and quotes the people's own words as data.

**Customer words never become instructions.** The Wright puts an issue's text into Claude Code's brief as it is, and its only safeguard is the issue's author. A report filed straight as an issue under the owner's name would be trusted completely; one filed by a bot account would never be picked up. So:

1. **Triage** (Claude Code in a Steward session, by hand at first, then daily): reads the groups as untrusted data, decides what each is (known and fixed in a newer version, a new combination to support, a bug, not ours), and for the ones with work in them writes an issue **in its own words**: the facts, the counts, the report ids, and a plan, in the repository that owns the fix, labelled `manor:work`. The owner's account files it, as now, so the Wright picks it up.
2. **The Wright** does the work and opens a draft pull request, as it does today. Two changes before it takes issues written from reports: its brief marks quoted text as data to be weighed, not instructions, and its Read and Edit stay inside its worktree.
3. **The owner** reviews and merges, as today. Nothing a customer writes reaches a merge without a person.

Once a fix ships, its group is marked fixed in that version, and reports from older versions point to the update.

## Compatibility for everyone

Most reports from the NPU will be about combinations: this generation, with this driver, with this server and model. Those become data in `npu-vendors.json`:

- a combination that fails is listed with what to do instead (a newer driver, a smaller cap, the graphics card), so setup on the next PC like it does that from the start, says why, and never fails the same way twice;
- a generation whose reports pass the NPU check and the benchmark is marked verified, as Lunar Lake is;
- the website's compatibility page and the benchmark's boards come from the same reports.

## What to build, in order

1. **The privacy notice first** (CastellanSite `app/privacy`): problem reports you choose to send, what's in them, what's never in them, how long they're kept (180 days), who processes them (Supabase and Cloudflare R2, already listed for licensing). Manor's Ask box wording becomes "nothing you ask leaves the PC unless you send it in a report". Heiward stays out of this: its store listing promises no data leaves at all.
2. **The kit**: `report.ts` builds, cleans and saves a report; `report.schema.json`; tests that a report never holds the user's name, the PC's name, a path under their folder or a token.
3. **Manor**: the Report a problem page, its preview and Send, saved reports, the email fallback; it sends for the agents.
4. **Agents' pages**: the link, and "This answer is wrong" in `page.ts` beside `unverified()`, and in Manor's Ask box and repairs.
5. **The Exchequer**: the `reports` handler and table, the limit, the prune, the publisher's read; its tests with the in-memory repository as the others have.
6. **The Steward's queue and triage**: `npm run reports`, grouping, and triage writing issues.
7. **The Wright's two changes**, before it takes an issue written from a report.

## Decisions for the owner

- Reports go to our own Exchequer (recommended) rather than an email address or a third-party form: it already knows each PC, rate-limits, and keeps no more than we choose.
- The question and answer are left out unless ticked (recommended), so "nothing you ask leaves the PC" stays true unless the person chooses otherwise.
- Triage writes the issues the Wright works from (recommended), never the reports themselves.
- 180 days' keeping (a guess: long enough to see a driver's problem through to its fix).
