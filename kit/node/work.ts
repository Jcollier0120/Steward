import { loadAccelerators, serves, theAccelerator, type Accelerator, type AcceleratorConfig } from './accelerators.ts';
import { APP } from '../app.ts';

/**
 * Where an agent's work runs (the processor, a graphics card, the NPU) and when: the "Where its work runs"
 * section of its Settings page (page.ts). Someone who sees the processor or a graphics card busy for a
 * minute, then quiet again, can tell which agent it was and why. Each kit agent's lines are kept here by its
 * id, beside the part every agent shares: Reeve's model, the accelerators this PC has, and how requests take
 * turns. An agent that isn't listed shows the shared part only. Manor's About page has the whole manor's at a
 * glance, and Reeve's and Heiward's Settings pages their own.
 */
export interface WorkLine {
  /** The work, as a person would name it. */
  what: string;
  /** Where it runs. */
  where: string;
  /** When, and for how long. */
  when: string;
}

export interface AgentWork {
  /** It sends requests to Reeve's model. */
  model: boolean;
  lines: WorkLine[];
  /** Anything else worth knowing, a sentence each. */
  notes?: string[];
}

const MODEL = "Reeve's model (below)";
const VISION = "Reeve's vision model (below)";

export const WORK: Record<string, AgentWork> = {
  porter: {
    model: true,
    lines: [
      { what: "Listing what's new: downloads, startup entries, scheduled tasks, services, listening ports, programs", where: 'the processor (PowerShell)', when: 'every 30 minutes, a few seconds' },
      { what: "Checking each newcomer's signature, and a new download's SHA-256 against its publisher's", where: 'the processor and the disk', when: 'in the same round; a big download takes longer (up to 16 GB a round, the rest the next)' },
      { what: 'A note on each newcomer', where: MODEL, when: 'at most 10 a round; each file is asked about once' },
    ],
  },
  auditor: {
    model: true,
    lines: [
      { what: "Reading each accelerator's toolchain: its driver, model server and runtime", where: 'the processor (WMI)', when: 'every hour, about 2 seconds' },
      { what: 'An audit: asking each model questions whose answers code checks', where: 'each accelerator Reeve lists, in turn: the NPU, a graphics card, the processor. This is on purpose', when: 'weekly, and when you press Audit now after a change' },
    ],
    notes: ['An audit is the one time an agent sends work to every accelerator, not just the first free one, so a graphics card or the processor working hard during an audit is expected.'],
  },
  clerk: {
    model: true,
    lines: [
      { what: "Reading the text in new screenshots and scans (Windows' own OCR), and in the first 5 pages of a PDF", where: 'the processor', when: 'every 15 minutes, while there are new files; a big batch can keep it busy for a minute or two' },
      { what: 'A caption for a picture with almost no text (a photo, a diagram)', where: VISION, when: 'in the same round, once per picture' },
      { what: 'Re-ranking a search by meaning, when that is on', where: "Reeve's embedding model, only when its server is already running", when: 'when you search' },
    ],
    notes: ["The NPU's own text recognizer would be faster, but Windows offers it only to packaged apps, so OCR runs on the processor for now."],
  },
  herald: {
    model: true,
    lines: [
      { what: 'Checking the upstream projects for new releases and issue changes', where: 'the network, and a little of the processor', when: 'every 6 hours; about 5 seconds when nothing is new' },
      { what: 'A short summary of each new release', where: MODEL, when: 'in the same round, once per release' },
    ],
  },
  warrener: {
    model: true,
    lines: [
      { what: "Looking at the loose files in Downloads and on the Desktop, reading a PDF's first page and pictures of documents (Windows' own OCR)", where: 'the processor', when: 'every hour; at most 40 PDFs, Office files and pictures a round' },
      { what: 'A name and a folder for each document', where: MODEL, when: 'at most 15 a round' },
      { what: 'Moving the files you tick', where: 'the disk', when: 'only when you press File the ticked ones' },
    ],
  },
  aletaster: {
    model: true,
    lines: [
      { what: "Comparing each project's versions, tags, changelog and release files, and the checksums of its local build", where: 'the network, and the processor and disk for the checksums', when: 'every 6 hours, or Run now' },
      { what: 'Asking Manor and the Steward who works at the manor, so each agent is tasted too', where: "Manor's and the Steward's pages, on this PC (a request to each)", when: 'at the start of the same round, a moment; about 14 projects a round in all' },
      { what: "Cloning a project that isn't on this PC (gh repo clone), and fetching each clone (git fetch), fast-forwarding its default branch when it's checked out and clean", where: 'the network and the disk', when: 'in the same round, just before each project is tasted; a first clone takes longer' },
      { what: 'A changelog line for each merged change that has none', where: MODEL, when: 'at most 12 a round, about 25 seconds on the NPU' },
      { what: "Handing a project's work orders to a worker, when Settings → Work orders names one (it's off by default), in a git worktree of its own", where: "Claude Code (claude -p), which runs on Anthropic's servers, with its tool calls on this PC's processor; or a command of yours, on this PC", when: 'at the end of the round, at most 2 projects, one at a time, each for at most 45 minutes (Time for each)' },
    ],
  },
  miller: {
    model: true,
    lines: [
      { what: 'Looking in the hopper', where: 'the disk', when: 'every minute, a folder listing' },
      { what: 'Grinding a video or photo down to size (FFmpeg)', where: "the first encoder that works here: the Snapdragon's own video encoder, else a graphics card's, else the processor (x265, x264, SVT-AV1)", when: 'one file at a time, at below-normal priority, for as long as that file takes' },
      { what: 'A name for each kept video, from one frame', where: VISION, when: 'every 5 minutes, at most 10 a round' },
    ],
    notes: ["Task Manager may count the video encoder's work as graphics use (Video Encode). It is the Miller grinding, and stops when the hopper is empty."],
  },
  pinder: {
    model: true,
    lines: [
      { what: 'One look at every process and listening port', where: 'the processor (PowerShell)', when: 'every 10 minutes, a few seconds' },
      { what: 'A one-line note on each stray', where: MODEL, when: 'at most 10 new a round' },
    ],
  },
  steward: {
    model: false,
    lines: [
      { what: "Rolling out a kit version: a worktree of each agent, its packages, its typecheck and tests, its release build", where: 'the processor, the disk and the network', when: 'only when a stage is started, two agents at a time (Settings), for a few minutes' },
    ],
    notes: ['Between stages it does nothing.'],
  },
  surveyor: {
    model: true,
    lines: [
      { what: "Its checks: Manor, every agent's page and logs, the PC (one PowerShell script) and the code checkouts", where: 'the processor and the disk', when: 'every 60 minutes (Settings), a few seconds to a minute' },
      { what: 'Explanations, the daily report, suggestions and what is new', where: MODEL, when: 'only when no other agent holds or waits for an accelerator; at most 8 a round' },
    ],
  },
};

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const WORK_NAMES: Record<string, string> = { chat: 'chat', vision: 'vision', embed: 'embeddings' };

/** One accelerator as the section names it: "the NPU (chat, vision)". */
const named = (a: Accelerator) => `${theAccelerator(a)} (${(['chat', 'vision', 'embed'] as const).filter((w) => serves(a, w)).map((w) => WORK_NAMES[w]).join(', ')})`;

/** What this PC has for the model, in the order requests try them, in words. */
export function thisPc(cfg: AcceleratorConfig | { error: string }): string {
  if ('error' in cfg) return `${cfg.error}, so there is no model work here.`;
  const on = cfg.accelerators.filter((a) => a.enabled !== false && (['chat', 'vision', 'embed'] as const).some((w) => serves(a, w)));
  const list = on.map(named).join(', then ');
  const onlyNpu = on.length > 0 && on.every((a) => a.kind === 'npu');
  return `On this PC, Reeve lists ${list}.${onlyNpu ? ' So its model work runs on the NPU only, never on the processor or a graphics card.' : ''}`;
}

/**
 * The section, as page.ts puts it in the Settings page. `o` is for tests: an agent and an accelerator config
 * of their own; by default this agent, and Reeve's config.json as the kit reads it for every request.
 */
export function workSection(o: { id?: string; name?: string; config?: AcceleratorConfig | { error: string } } = {}): string {
  const id = o.id ?? APP.id;
  const name = o.name ?? APP.name;
  const w = WORK[id];
  const rows = (w?.lines ?? []).map((l) => `<tr><td>${esc(l.what)}</td><td>${esc(l.where)}</td><td>${esc(l.when)}</td></tr>`).join('');
  const table = rows ? `<table class="work-table"><tr><th>What</th><th>Where it runs</th><th>When</th></tr>${rows}</table>` : '';
  const notes = (w?.notes ?? []).map((n) => `<p class="muted small">${esc(n)}</p>`).join('');
  const model = w && !w.model
    ? `<p>${esc(name)} uses no model.</p>`
    : `<p><strong>Its model work</strong> goes to the model servers Reeve runs, as requests that take turns with every other agent's: one at a time on the NPU, and as many as a graphics card's server has slots. Each request goes to the first one in Reeve's order that is free and hasn't failed in the last 10 minutes (by default: graphics cards with 2 GB or more of their own memory, then the NPU, then graphics that share the PC's memory, then the processor). Background work keeps off a graphics card a game is using. ${esc(thisPc(o.config ?? loadAccelerators()))}</p>
<p class="muted small">Task Manager shows the NPU's work on a graph of its own (Performance, then NPU), not as processor or graphics use.</p>`;
  return `<section class="work-runs" data-settings-extra>
<h2>Where its work runs</h2>
<div class="card">
<p>What ${esc(name)} does on this PC, where, and when. It works in rounds and does nothing in between, so the processor or a graphics card busy for a moment, then quiet again, is expected.</p>
${table}${notes}${model}
</div>
</section>`;
}
