import { loadAccelerators, serves, theAccelerator, type Accelerator, type AcceleratorConfig } from './accelerators.ts';
import { APP } from '../app.ts';
import { isDeveloper } from './developer.ts';

/**
 * Where an agent's work runs (the processor, a graphics card, the NPU) and when: the "Where its work runs"
 * section of its Settings page (page.ts). Someone who sees the processor or a graphics card busy for a
 * minute, then quiet again, can tell which agent it was and why. Each kit agent's lines are kept here by its
 * id, beside the part every agent shares: Reeve's model, the accelerators this PC has, and how requests take
 * turns. An agent that isn't listed shows the shared part only. Manor's About page has the whole manor's at a
 * glance, and Reeve's and Heiward's Settings pages their own.
 *
 * With the manor's Developer options off (developer.ts, spec/DEVELOPER-OPTIONS.md), the section is said in plain
 * words: "the local AI" for Reeve's model and its servers, "the AI chip" for the NPU, each line's `plain` wording, no
 * developer-only line, and no tool, command, model server, chip maker or Task Manager graph by name. A developer
 * role (`developerRole`), whose work doesn't run while the switch is off, has no section then at all.
 */
export interface WorkLine {
  /** The work, as a person would name it. */
  what: string;
  /** Where it runs. */
  where: string;
  /** When, and for how long. */
  when: string;
  /**
   * The line in plain words, for when Developer options are off: no tools, commands, ports, checksums or model
   * servers by name, and "the local AI" for Reeve's model. A field left out is said as above.
   */
  plain?: Partial<Pick<WorkLine, 'what' | 'where' | 'when'>>;
  /** Developer work (repositories, builds, upstream projects): shown only while Developer options are on. */
  dev?: boolean;
}

export interface AgentWork {
  /** It sends requests to Reeve's model. */
  model: boolean;
  /** Its requests go to the NPU only, never a graphics card or the processor (the Lamplighter's: the GPU is what it guards). */
  npuOnly?: boolean;
  lines: WorkLine[];
  /** Anything else worth knowing, a sentence each. */
  notes?: string[];
  /** The notes in plain words, for when Developer options are off; `notes` when left out. */
  plainNotes?: string[];
  /**
   * One of the manor's developer roles (the Auditor, the Developer Herald, the Aletaster, the Pinder, the Steward, the Toller, the Assayer):
   * its work runs only while Developer options are on, so with them off its page has no "Where its work runs".
   */
  developerRole?: boolean;
}

const MODEL = "Reeve's model (below)";
const VISION = "Reeve's vision model (below)";
/** MODEL and VISION in plain words. */
const PLAIN_WHERE: Record<string, string> = { [MODEL]: 'the local AI (below)', [VISION]: 'the local AI (below)' };
/** The NPU in plain words. */
const AI_CHIP = 'the AI chip';

export const WORK: Record<string, AgentWork> = {
  porter: {
    model: true,
    lines: [
      { what: "Listing what's new: downloads, startup entries, scheduled tasks, services, listening ports, programs", where: 'the processor (PowerShell)', when: 'every 30 minutes, a few seconds', plain: { what: "Listing what's new: downloads, programs, what starts with Windows, scheduled tasks and services", where: 'the processor' } },
      { what: "Checking each newcomer's signature, and a new download's SHA-256 against its publisher's", where: 'the processor and the disk', when: 'in the same round; a big download takes longer (up to 16 GB a round, the rest the next)', plain: { what: 'Checking that each newcomer is signed, and that a new download is the one its publisher made' } },
      { what: 'A note on each newcomer', where: MODEL, when: 'at most 10 a round; each file is asked about once' },
    ],
  },
  auditor: {
    model: true,
    developerRole: true,
    lines: [
      { what: "Reading each accelerator's toolchain: its driver, model server and runtime", where: 'the processor (WMI)', when: 'every hour, about 2 seconds', plain: { what: "Reading each accelerator's driver and software", where: 'the processor' } },
      { what: 'An audit: asking each model questions whose answers code checks', where: 'each accelerator Reeve lists, in turn: the NPU, a graphics card, the processor. This is on purpose', when: 'weekly, and when you press Audit now after a change', plain: { what: 'An audit: asking the local AI questions whose answers it checks', where: 'each part of this PC that can run the local AI, in turn: the AI chip, a graphics card, the processor. This is on purpose' } },
    ],
    notes: ['An audit is the one time an agent sends work to every accelerator, not just the first free one, so a graphics card or the processor working hard during an audit is expected.'],
  },
  clerk: {
    model: true,
    lines: [
      { what: "Reading the text in new screenshots and scans (Windows' own OCR), and in the first 5 pages of a PDF", where: 'the processor', when: 'every 15 minutes, while there are new files; a big batch can keep it busy for a minute or two', plain: { what: "Reading the text in new screenshots and scans (Windows' own text recognition), and in the first 5 pages of a PDF" } },
      { what: 'A caption for a picture with almost no text (a photo, a diagram)', where: VISION, when: 'in the same round, once per picture' },
      { what: 'Re-ranking a search by meaning, when that is on', where: "Reeve's embedding model, only when its server is already running", when: 'when you search', plain: { where: 'the local AI, only when it is already running' } },
    ],
    notes: ["The NPU's own text recognizer would be faster, but Windows offers it only to packaged apps, so OCR runs on the processor for now."],
    plainNotes: ["The AI chip's own text recognition would be faster, but Windows doesn't offer it to the Clerk yet, so reading text runs on the processor for now."],
  },
  herald: {
    model: true,
    lines: [
      { what: "Reading your sources: your games and drivers, news, the weather and markets, or your PC's updates and security flaws, as its variant says", where: 'the network, and a little of the processor (it reads what is installed with PowerShell)', when: 'every hour for General purpose and the Financial guru, every 6 hours for Gamer and PC caretaker; a few seconds when nothing is new', plain: { where: 'the network, and a little of the processor' } },
      { what: 'A short summary of each new set of long notes', where: MODEL, when: 'in the same round, at most 6 a round' },
    ],
  },
  'developer-herald': {
    model: true,
    developerRole: true,
    lines: [
      { what: 'Checking the upstream projects for new releases and issue changes', where: 'the network, and a little of the processor', when: 'every 6 hours; about 5 seconds when nothing is new', dev: true },
      { what: 'A short summary of each new release', where: MODEL, when: 'in the same round, once per release', dev: true },
    ],
  },
  warrener: {
    model: true,
    lines: [
      { what: "Looking at the loose files in Downloads and on the Desktop, reading a PDF's first page and pictures of documents (Windows' own OCR)", where: 'the processor', when: 'every hour; at most 40 PDFs, Office files and pictures a round', plain: { what: "Looking at the loose files in Downloads and on the Desktop, reading a PDF's first page and pictures of documents (Windows' own text recognition)" } },
      { what: 'A name and a folder for each document', where: MODEL, when: 'at most 15 a round' },
      { what: 'Moving the files you tick', where: 'the disk', when: 'only when you press File the ticked ones' },
    ],
  },
  aletaster: {
    model: true,
    developerRole: true,
    lines: [
      { what: "Comparing each project's versions, tags, changelog and release files, and the checksums of its local build", where: 'the network, and the processor and disk for the checksums', when: 'every 6 hours, or Run now', dev: true },
      { what: 'Asking Castellan and the Steward who works at the manor, so each agent is tasted too', where: "Castellan's and the Steward's pages, on this PC (a request to each)", when: 'at the start of the same round, a moment; about 14 projects a round in all', dev: true },
      { what: "Cloning a project that isn't on this PC (gh repo clone), and fetching each clone (git fetch), fast-forwarding its default branch when it's checked out and clean", where: 'the network and the disk', when: 'in the same round, just before each project is tasted; a first clone takes longer', dev: true },
      { what: 'A changelog line for each merged change that has none', where: MODEL, when: 'at most 12 a round, about 25 seconds on the NPU', dev: true },
      { what: "Handing a project's work orders to a worker, when Settings → Work orders names one (it's off by default), in a git worktree of its own", where: "Claude Code (claude -p), which runs on Anthropic's servers, with its tool calls on this PC's processor; or a command of yours, on this PC", when: 'at the end of the round, at most 2 projects, one at a time, each for at most 20 minutes (Time for each)', dev: true },
    ],
  },
  miller: {
    model: true,
    lines: [
      { what: 'Looking in the hopper', where: 'the disk', when: 'every minute, a folder listing' },
      { what: 'Grinding a video or photo down to size (FFmpeg)', where: "the first encoder that works here: the Snapdragon's own video encoder, else a graphics card's, else the processor (x265, x264, SVT-AV1)", when: 'one file at a time, at below-normal priority, for as long as that file takes', plain: { what: 'Grinding a video or photo down to size', where: "the first video encoder that works here: the one built into this PC's processor chip, else a graphics card's, else the processor" } },
      { what: 'A name for each kept video, from one frame', where: VISION, when: 'every 5 minutes, at most 10 a round' },
    ],
    notes: ["Task Manager may count the video encoder's work as graphics use (Video Encode). It is the Miller grinding, and stops when the hopper is empty."],
    plainNotes: ['Windows may count the video encoding as graphics use. It is the Miller grinding, and stops when the hopper is empty.'],
  },
  pinder: {
    model: true,
    developerRole: true,
    lines: [
      { what: 'One look at every process and listening port', where: 'the processor (PowerShell)', when: 'every 10 minutes, a few seconds', plain: { what: 'One look at every program running', where: 'the processor' } },
      { what: 'A one-line note on each stray', where: MODEL, when: 'at most 10 new a round' },
    ],
  },
  steward: {
    model: false,
    developerRole: true,
    lines: [
      { what: "Rolling out a kit version: a worktree of each agent, its packages, its typecheck and tests, its release build", where: 'the processor, the disk and the network', when: 'only when a stage is started, two agents at a time (Settings), for a few minutes', dev: true },
    ],
    notes: ['Between stages it does nothing.'],
  },
  toller: {
    model: false,
    developerRole: true,
    lines: [
      { what: "A round over your projects and tools: each lockfile, for what was added, updated and removed; each file changed since the last look, for secrets left in it; your editors' extensions, global tools, PATH and git settings", where: 'the processor and the disk', when: 'every hour (Settings), a few seconds; a file read before and unchanged since is not read again', dev: true },
      { what: 'One look at the listening ports, for a dev server open to the network', where: 'the processor (PowerShell)', when: 'in the same round, a moment', dev: true },
    ],
    notes: ['It uses no model and nothing goes over the network: what it finds, its own code finds.'],
  },
  assayer: {
    model: false,
    developerRole: true,
    lines: [
      { what: "Testing a branch or a draft: the project's test command, in a throwaway git worktree of its own", where: 'the processor and the disk, at below-normal priority, so never ahead of your own work', when: 'every 15 minutes (Settings), at most 3 test runs a round, one at a time; each project\'s branch once a day', dev: true },
    ],
    notes: ['It uses no model, and never merges, tags or releases anything: what passes becomes a pull request for you.'],
  },
  surveyor: {
    model: true,
    lines: [
      { what: "Its checks: Castellan, every agent's page and logs, the PC (one PowerShell script) and the code checkouts", where: 'the processor and the disk', when: 'every 60 minutes (Settings), a few seconds to a minute', plain: { what: "Its checks: Castellan, every agent's page, and the PC" } },
      { what: 'Explanations, the daily report, suggestions and what is new', where: MODEL, when: 'only when no other agent holds or waits for an accelerator; at most 8 a round' },
    ],
  },
  lamplighter: {
    model: true,
    npuOnly: true,
    lines: [
      { what: "Its guard: reading the graphics cards, the event log and who signed in, and archiving a new driver (pnputil /export-driver) with each file's SHA-256", where: 'the processor and the disk, as SYSTEM (Windows PowerShell); never the graphics card', when: 'at start-up and sign-in, when a driver is installed or the display resets, and every 5 minutes, about a second; an export takes longer (a driver can be 500 MB)', plain: { what: "Its guard: reading the graphics cards, Windows' record of what happened and who signed in, and keeping a copy of each new graphics driver", where: 'the processor and the disk, as an administrator; never the graphics card', when: 'at start-up and sign-in, when a driver is installed or the screen resets, and every 5 minutes, about a second; keeping a copy takes longer (a driver can be 500 MB)' } },
      { what: 'Rolling a driver back: removing the new one, and installing the last good one from the archive (pnputil)', where: 'the processor and the disk, as SYSTEM', when: 'only after a new graphics driver nobody kept at sign-in, or that left the screen dark', plain: { what: 'Rolling a driver back: removing the new one, and putting back the last good one it kept', where: 'the processor and the disk, as an administrator' } },
      { what: 'Its page: reading what the guard did, and the graphics cards', where: 'the processor (PowerShell)', when: 'every 5 minutes (Settings), a moment', plain: { where: 'the processor' } },
      { what: 'A few plain sentences on a rollback', where: "Reeve's model on the NPU only (below)", when: 'after a rollback, only when no other agent holds or waits for the NPU', plain: { where: 'the local AI, on the AI chip only (below)', when: 'after a rollback, only when no other agent is using the AI chip' } },
    ],
    notes: ['The guard is the one part of the manor that runs as an administrator (SYSTEM), and it uses no model: detecting a dark screen and rolling back are code.'],
    plainNotes: ['The guard is the one part of the manor that runs as an administrator, and it uses no AI: noticing a dark screen and rolling back are its own work.'],
  },
  smith: {
    model: false,
    lines: [
      { what: 'A look at every model server: who uses each accelerator, whether each answers, how much memory GenieX holds, whether a game wants a graphics card, and any model server nobody configured', where: 'the processor (one PowerShell process list) and the model servers on this PC', when: 'every minute, a moment', plain: { what: 'A look at the local AI: who uses each accelerator, whether it answers, how much memory it holds, and whether a game wants a graphics card', where: 'the processor' } },
      { what: 'Stopping a server nobody has used for 10 minutes (Settings), one a game needs the card back from, or an orphan; restarting one that stopped answering or holds too much', where: 'the model servers it keeps: GenieX on the NPU, llama-server on a graphics card or the processor', when: 'only when nobody holds or waits for that accelerator', plain: { what: 'Resting the local AI when nobody has used it for 10 minutes (Settings) or a game needs the graphics card back; starting it again when it stops answering or holds too much memory', where: 'the AI chip, a graphics card or the processor, wherever the local AI runs' } },
      { what: 'Setting up a graphics card or the processor: llama.cpp and the models, downloaded and checked', where: 'the network and the disk (some 6 GB), and a moment of the graphics card to list its devices', when: 'only when you press Set up', plain: { what: 'Setting up a graphics card or the processor for the local AI: its software and models, downloaded and checked', where: 'the network and the disk (some 6 GB), and a moment of the graphics card' } },
    ],
    notes: ["The model servers run every other agent's model work, not the Smith's: it uses no model, it keeps them. A server it stops starts again by itself at the next request, in seconds."],
    plainNotes: ["The local AI does every other agent's AI work, not the Smith's: the Smith uses none, it looks after it. When it rests, it starts again by itself the next time an agent needs it, in seconds."],
  },
  thatcher: {
    model: true,
    lines: [
      { what: 'Asking winget which installed apps have upgrades', where: 'the processor', when: 'every 6 hours, a few seconds', plain: { what: 'Asking Windows which installed apps have upgrades' } },
      { what: 'One line on what each upgrade changes', where: MODEL, when: 'at most 10 a round' },
      { what: 'Installing the upgrades you tick', where: 'the processor, the disk and the network', when: 'only when you tick them, one at a time' },
    ],
  },
  reckoner: {
    model: true,
    lines: [
      { what: 'Taking stock of the devices', where: 'the processor (PowerShell)', when: 'every hour and soon after an update, a few seconds', plain: { where: 'the processor' } },
      { what: 'A few plain words when something changed', where: MODEL, when: 'only when it did, at most 3 a round' },
    ],
  },
  weigher: {
    model: false,
    lines: [
      { what: 'A check that the line is up', where: 'the network', when: 'every minute, one small request' },
      { what: 'A speed sample', where: 'the network', when: 'every 3 hours and when you press Sample now: 10 MB down and 5 MB up by default, never on a metered connection' },
    ],
    notes: ['It has no model work: weighing the line is measuring, and its own code does it.'],
    plainNotes: ['It uses no AI: weighing the line is measuring, and it does that itself.'],
  },
  shepherd: {
    model: true,
    lines: [
      { what: "One look at every app's processor, memory and battery use, and what starts with Windows", where: 'the processor (PowerShell)', when: 'every 10 minutes, a few seconds', plain: { where: 'the processor' } },
      { what: 'A one-line note on each app it rounds up', where: MODEL, when: 'at most 10 new a round' },
    ],
  },
};

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const WORK_NAMES: Record<string, string> = { chat: 'chat', vision: 'vision', embed: 'embeddings' };

/** One accelerator as the section names it: "the NPU (chat, vision)". */
const named = (a: Accelerator) => `${theAccelerator(a)} (${(['chat', 'vision', 'embed'] as const).filter((w) => serves(a, w)).map((w) => WORK_NAMES[w]).join(', ')})`;

/**
 * One accelerator in plain words: the AI chip and the processor (not their maker's names), and a graphics card as
 * the person knows it ("the NVIDIA GeForce RTX 4090").
 */
const plainNamed = (a: Accelerator) => (a.kind === 'npu' ? AI_CHIP : a.kind === 'cpu' ? 'the processor' : theAccelerator(a));

/**
 * What this PC has for the model, in the order requests try them, in words. `developer` (the manor's Developer
 * options) names Reeve, which keeps the list, and each accelerator with the work it serves; without, it's "the local
 * AI", the NPU is the AI chip, and the work isn't named.
 */
export function thisPc(cfg: AcceleratorConfig | { error: string }, developer = true): string {
  if ('error' in cfg) return developer ? `${cfg.error}, so there is no model work here.` : "The local AI isn't set up on this PC, so there is no AI work here.";
  const on = cfg.accelerators.filter((a) => a.enabled !== false && (['chat', 'vision', 'embed'] as const).some((w) => serves(a, w)));
  const onlyNpu = on.length > 0 && on.every((a) => a.kind === 'npu');
  if (!developer) return `On this PC, the local AI uses ${[...new Set(on.map(plainNamed))].join(', then ')}.${onlyNpu ? ' So its AI work runs on the AI chip only, never on the processor or a graphics card.' : ''}`;
  return `On this PC, Reeve lists ${on.map(named).join(', then ')}.${onlyNpu ? ' So its model work runs on the NPU only, never on the processor or a graphics card.' : ''}`;
}

/** A line as the section says it: as written for a developer, else in its plain words; null for a developer-only line. */
export function workLine(l: WorkLine, developer: boolean): Pick<WorkLine, 'what' | 'where' | 'when'> | null {
  if (developer) return { what: l.what, where: l.where, when: l.when };
  if (l.dev) return null;
  return { what: l.plain?.what ?? l.what, where: l.plain?.where ?? PLAIN_WHERE[l.where] ?? l.where, when: l.plain?.when ?? l.when };
}

/**
 * The section, as page.ts puts it in the Settings page. `developer` is the manor's Developer options (developer.ts),
 * read now unless given. `o` is for tests too: an agent and an accelerator config of their own; by default this
 * agent, and Reeve's config.json as the kit reads it for every request. Empty for a developer role with the switch
 * off: none of its work runs then.
 */
export function workSection(o: { id?: string; name?: string; config?: AcceleratorConfig | { error: string }; developer?: boolean } = {}): string {
  const id = o.id ?? APP.id;
  const name = o.name ?? APP.name;
  const dev = o.developer ?? isDeveloper();
  const w = WORK[id];
  if (!dev && w?.developerRole) return '';
  const rows = (w?.lines ?? [])
    .map((l) => workLine(l, dev))
    .filter((l) => l !== null)
    .map((l) => `<tr><td>${esc(l.what)}</td><td>${esc(l.where)}</td><td>${esc(l.when)}</td></tr>`)
    .join('');
  const table = rows ? `<table class="work-table"><tr><th>What</th><th>Where it runs</th><th>When</th></tr>${rows}</table>` : '';
  const notes = ((dev ? w?.notes : w?.plainNotes ?? w?.notes) ?? []).map((n) => `<p class="muted small">${esc(n)}</p>`).join('');
  const cfg = () => o.config ?? loadAccelerators();
  const hasNpu = () => {
    const c = cfg();
    return !('error' in c) && c.accelerators.some((a) => a.kind === 'npu' && a.enabled !== false && serves(a, 'chat'));
  };
  const model = w && !w.model
    ? `<p>${esc(name)} uses no ${dev ? 'model' : 'AI'}.</p>`
    : dev
      ? w?.npuOnly
        ? `<p><strong>Its model work</strong> goes to the NPU only, through the model server Reeve runs there, taking its turn in the NPU's line with every other agent's requests, and only when no other agent holds or waits for it. Never to a graphics card or the processor, whatever Reeve's order says. ${hasNpu() ? 'This PC has one.' : "This PC has none, so it asks no model, and its words are its own code's."}</p>
<p class="muted small">Task Manager shows the NPU's work on a graph of its own (Performance, then NPU), not as processor or graphics use.</p>`
        : hasNpu()
          ? `<p><strong>Its model work</strong> goes to the model servers Reeve runs, as requests that take turns with every other agent's: one at a time on the NPU, and as many as a graphics card's server has slots. The NPU comes first (by default; Reeve's order can say otherwise): it does model work without the processor or a graphics card, so every request it can do waits its turn there, even when another is free. A graphics card or the processor takes a request only when the NPU can't: it doesn't serve that work, the request is too big for it, or it failed in the last 10 minutes. Then the order is graphics cards with 2 GB or more of their own memory, then graphics that share the PC's memory, then the processor. Background work keeps off a graphics card a game is using. ${esc(thisPc(cfg(), true))}</p>
<p class="muted small">Task Manager shows the NPU's work on a graph of its own (Performance, then NPU), not as processor or graphics use.</p>`
          : `<p><strong>Its model work</strong> goes to the model servers Reeve runs, as requests that take turns with every other agent's: as many at once as a server has slots. Graphics cards with 2 GB or more of their own memory come first, the most memory first, then graphics that share the PC's memory, then the processor (by default; Reeve's order can say otherwise). The next one takes a request only when the one before can't: it doesn't serve that work, the request is too big for it, or it failed in the last 10 minutes. Background work keeps off a graphics card a game is using, and waits for it rather than slow the game. ${esc(thisPc(cfg(), true))}</p>
<p class="muted small">Task Manager shows the model's work as the graphics card's (Performance, then GPU) or the processor's.</p>`
      // In plain words: the local AI, the AI chip, and no Task Manager graph.
      : w?.npuOnly
        ? `<p><strong>Its AI work</strong> goes to the local AI on the AI chip only, taking its turn with every other agent's, and only when no other agent is using it. Never to a graphics card or the processor. ${hasNpu() ? 'This PC has one.' : 'This PC has none, so it asks no AI, and its words are its own.'}</p>`
        : hasNpu()
          ? `<p><strong>Its AI work</strong> goes to the local AI, taking turns with every other agent's. The AI chip comes first: it does AI work without the processor or a graphics card. A graphics card or the processor takes a request only when the AI chip can't, or when it's too big for it. Background work keeps off a graphics card a game is using. ${esc(thisPc(cfg(), false))}</p>`
          : `<p><strong>Its AI work</strong> goes to the local AI, taking turns with every other agent's: on a graphics card first, the one with the most memory, then the processor. Background work keeps off a graphics card a game is using, and waits for it rather than slow the game. ${esc(thisPc(cfg(), false))}</p>`;
  return `<section class="work-runs" data-settings-extra>
<h2>Where its work runs</h2>
<div class="card">
<p>What ${esc(name)} does on this PC, where, and when. It works in rounds and does nothing in between, so the processor or a graphics card busy for a moment, then quiet again, is expected.</p>
${table}${notes}${model}
</div>
</section>`;
}
