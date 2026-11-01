import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The page of an MCP staff (react/staff.tsx, spec/STAFF-PAGE.md): its order, the tiles, Connect your AI, Kept and the
// side panel, rendered with react-dom/server. What a page draws from them, not how they look.
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
const { bundleForNode, importPath } = await import('./react-render.ts');

const ui = await bundleForNode<{ html: Record<string, () => string> }>(
  `import { renderToStaticMarkup as r } from 'react-dom/server';
   import { ConnectAI, Glance, Kept, NeedsYou, Output, Paste, Row, SidePanel, StaffLayout } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
   const setups = [
     { id: 'claude-code', name: 'Claude Code', where: 'Run this once in a terminal.', text: 'claude mcp add --scope user assayer -- node cli.ts mcp' },
     { id: 'json', name: 'Claude Desktop, Cursor', where: "Add this to the tool's MCP settings.", text: '{ "mcpServers": {} }' },
   ];
   const recent = new Date(Date.now() - 3 * 60_000).toISOString();
   export const html = {
     glance: () => r(<Glance tiles={[
       { label: 'Didn\\'t pass', value: '2', note: 'Heiward, Manor', tone: 'danger', to: 'failed' },
       { label: 'Ready for you', value: 'Nothing', note: 'nothing waiting' },
       { label: 'New alerts', value: '3', tone: 'caution', action: <button type="button">Mark seen</button>, to: 'alerts' },
     ]} />),
     notYet: () => r(<ConnectAI agent="the Assayer" connected={false} status="Not connected." action={<button type="button">Connect Claude Code</button>} setups={setups} instruction="Run tests through the Assayer." />),
     connected: () => r(<ConnectAI agent="Reeve" connected clients={[{ name: 'Claude Code', lastUsed: recent }, { name: 'Claude Code', lastUsed: null }]} setups={setups}><p>reminders</p></ConnectAI>),
     assistantRows: [
       { id: 'zed', name: 'Zed', state: 'not-installed' },
       { id: 'cursor', name: 'Cursor', state: 'connected', canWrite: true },
       { id: 'codex', name: 'Codex CLI', state: 'installed', canWrite: true },
       { id: 'claude-code', name: 'Claude Code', state: 'installed', canWrite: false, where: 'Run this once in a terminal.', paste: 'claude mcp add --scope user reeve -- node cli.ts mcp' },
       { id: 'gemini', name: 'Gemini CLI', state: 'installed', canWrite: true, problem: "Gemini CLI's settings don't parse as JSON with comments (it ends too soon, line 3)." },
       { id: 'continue', name: 'Continue', state: 'connected', canWrite: false, paste: 'mcpServers: []' },
     ],
     get assistants() { return () => r(<ConnectAI agent="Reeve" connected={false} setups={[]} assistants={this.assistantRows} onConnect={() => {}} onDisconnect={() => {}} />); },
     get assistantsNoHandlers() { return () => r(<ConnectAI agent="Reeve" connected={false} setups={[]} assistants={this.assistantRows} />); },
     assistantsNone: () => r(<ConnectAI agent="Reeve" connected={false} setups={[]} assistants={[]} />),
     kept: () => r(<Kept intro="Tokens Reeve read" stats={[{ label: 'This month (October)', value: 'about 4.8M tokens', note: 'about $14.46' }]} rows={[{ name: 'outline', value: 'about 2.9M', note: '(246 calls)' }]} counted empty="Nothing counted yet." footnote="Estimates." />),
     keptNone: () => r(<Kept title="Kept out of your AI's context" stats={[{ label: 'All time', value: 'None yet' }]} rows={[{ name: 'check', value: '0' }]} counted={false} empty="Nothing counted yet." />),
     panel: () => r(<SidePanel title="Heiward: unit tests" meta={['exit 1, 2 hours ago']} onClose={() => {}}><Output text={'line 1\\nline 2'} /></SidePanel>),
     paste: () => r(<Paste text="echo hi" label="A command" />),
     needs: () => r(<StaffLayout needs needsYou={<i>needs</i>} glance={<b>glance</b>} connect={<u>connect</u>} kept={<s>kept</s>}><em>own</em></StaffLayout>),
     calm: () => r(<StaffLayout needsYou={<i>needs</i>} glance={<b>glance</b>}><em>own</em></StaffLayout>),
     needsYou: () => r(<NeedsYou items={[
       { id: 'p', tone: 'danger', label: 'problem', title: 'The round failed', text: 'gh is signed out.' },
       { id: 's', tone: 'caution', label: 'Settings', title: 'A test command', action: <button type="button">Open Settings</button> },
     ]} />),
     nothingNeeds: () => r(<NeedsYou items={[]} />),
     needsAndMore: () => r(<NeedsYou items={[{ id: 'p', tone: 'danger', label: 'problem', title: 'The round failed' }]}><p className="muted small">No review queue yet.</p></NeedsYou>),
     nothingAndMore: () => r(<NeedsYou items={[]}><p className="muted small">No review queue yet.</p></NeedsYou>),
     row: () => r(<Row mark={<span className="badge">failed</span>} title="Heiward" meta="2 hours ago" actions={<button type="button">Output</button>} more={<p>more</p>} />),
     rowOpen: () => r(<Row title="Manor" more={<p>more</p>} open />),
     rowPlain: () => r(<Row title="Porter" meta="passes" />),
   };`,
);
const h = ui.html;

test('the page keeps its order: what needs you first, only while something does, then at a glance, Connect, Kept, its own', () => {
  assert.equal(h.needs(), '<div class="ui-staff"><i>needs</i><b>glance</b><u>connect</u><s>kept</s><em>own</em></div>');
  assert.equal(h.calm(), '<div class="ui-staff"><b>glance</b><em>own</em></div>');
});

test('a tile is a button to its section, its tone on its edge; one with an action goes nowhere itself', () => {
  const g = h.glance();
  assert.match(g, /^<div class="ui-glance" role="group" aria-label="At a glance" data-tour="glance">/);
  assert.match(g, /<button type="button" class="ui-tile ui-tile-danger"><span class="ui-tile-label">Didn&#x27;t pass<\/span><span class="ui-tile-value">2<\/span><span class="ui-tile-note">Heiward, Manor<\/span><\/button>/);
  assert.match(g, /<div class="ui-tile ui-tile-static"><span class="ui-tile-label">Ready for you<\/span>/, 'neutral is plain, and with no section it is no button');
  assert.match(g, /<div class="ui-tile ui-tile-caution ui-tile-static">.*<button type="button">Mark seen<\/button><\/div>/);
});

test('Connect your AI is open until an AI is connected: the action, each tool as a tab, its setup and the instructions line', () => {
  const c = h.notYet();
  assert.match(c, /^<details class="card ui-connect ui-connect-todo" data-tour="connect" open="">/);
  assert.match(c, /<summary><strong>Connect your AI to the Assayer<\/strong><span class="muted small"> Not connected\.<\/span><\/summary>/);
  assert.match(c, /The Assayer is an MCP server/, 'its name capitalised to start the sentence');
  assert.match(c, /<div class="ui-connect-action"><button type="button">Connect Claude Code<\/button><\/div>/);
  // What it connects with a press, and the setups for the rest, each under its heading.
  assert.match(c, /<h4 class="ui-connect-head">Assistants the Assayer connects for you<\/h4><div class="ui-connect-action">/);
  assert.match(c, /<h4 class="ui-connect-head">Other assistants<\/h4><p class="small muted">Not in the list above: set it up yourself, once\.<\/p><div class="ui-connect-tools"/);
  assert.doesNotMatch(h.assistants(), /ui-connect-head/, 'only the rows, no setups: no headings');
  assert.match(c, /<button type="button" role="tab" aria-selected="true" class="small">Claude Code<\/button><button type="button" role="tab" aria-selected="false" class="small quiet">Claude Desktop, Cursor<\/button>/);
  assert.match(c, /<pre aria-label="Claude Code setup">claude mcp add --scope user assayer -- node cli\.ts mcp<\/pre>/);
  assert.match(c, /<pre aria-label="The line for its instructions">Run tests through the Assayer\.<\/pre>/);
});

test('once connected it is one line naming the AI and when it last used the tools, folded, opening to connect another', () => {
  const c = h.connected();
  assert.match(c, /^<details class="card ui-connect" data-tour="connect">/, 'folded, and not marked to do');
  assert.match(c, /<span class="ui-ok">✓<\/span> Your AI is connected to Reeve<\/strong><span class="muted small"> Claude Code, last used 3 minutes ago<\/span><span class="muted small"> · open it to connect another AI tool<\/span>/);
  assert.match(c, /<p>reminders<\/p><\/details>$/);
});

test("Connect your AI lists each assistant: installed ones first, its state, and Connect, Disconnect or the text to paste", () => {
  const c = h.assistants();
  const rows = [...c.matchAll(/<li class="ui-assistant[^"]*" data-assistant="([^"]+)" data-state="([^"]+)">(.*?)<\/li>/g)].map((m) => ({ id: m[1], state: m[2], body: m[3] }));
  assert.deepEqual(rows.map((r) => `${r.id} ${r.state}`), ['cursor connected', 'codex installed', 'claude-code installed', 'gemini installed', 'continue connected', 'zed not-installed'], 'not installed last, the rest as given');
  assert.match(c, /<ul class="ui-assistants" aria-label="Your AI assistants">/);
  const row = (id: string) => rows.find((r) => r.id === id)!.body;
  // Each one's state, in words.
  assert.match(row('cursor'), /<strong>Cursor<\/strong><span class="[^"]*">Connected<\/span>/);
  assert.match(row('codex'), /Not connected/);
  assert.match(row('zed'), /Not installed/);
  assert.match(c, /<li class="ui-assistant muted" data-assistant="zed"/, 'one that is not installed is muted');
  // Disconnect where it's connected and the agent wrote it; Connect where it's installed and the agent may write.
  assert.match(row('cursor'), /aria-label="Disconnect Cursor from Reeve"[^>]*>.*Disconnect/);
  assert.doesNotMatch(row('cursor'), /Connect Cursor/);
  assert.match(row('codex'), /aria-label="Connect Codex CLI to Reeve"/);
  // Where the agent can't write: where to put it, and the text to paste; no button.
  assert.match(row('claude-code'), /<p class="small">Run this once in a terminal\.<\/p>/);
  assert.match(row('claude-code'), /claude mcp add --scope user reeve -- node cli\.ts mcp/);
  assert.doesNotMatch(row('claude-code'), /aria-label="(Connect|Disconnect) /);
  assert.doesNotMatch(row('continue'), /aria-label="Disconnect /, "connected by hand: the agent doesn't take out what it can't write");
  assert.match(row('continue'), /mcpServers: \[\]/);
  // A file that doesn't parse: said, and no Connect.
  assert.match(row('gemini'), /<p class="small ui-warn">Gemini CLI&#x27;s settings don&#x27;t parse as JSON with comments \(it ends too soon, line 3\)\.<\/p>/);
  assert.doesNotMatch(row('gemini'), /aria-label="Connect /);
  // Not installed: nothing to press, nothing to paste.
  assert.doesNotMatch(row('zed'), /<button|<pre/);
  // With no handlers there's nothing to press, and the list still says each one's state.
  const quiet = h.assistantsNoHandlers();
  assert.doesNotMatch(quiet, /aria-label="(Connect|Disconnect) [^"]+ (to|from) Reeve"/);
  assert.match(quiet, /data-assistant="cursor" data-state="connected"/);
  assert.doesNotMatch(h.assistantsNone(), /ui-assistants/, 'none found: no list');
  assert.doesNotMatch(h.notYet(), /ui-assistants/, "a page that doesn't give them draws as before");
});

test('Kept: its totals, what each part read once something is counted, else its empty note', () => {
  const k = h.kept();
  assert.match(k, /^<section class="card ui-kept" data-tour="kept" aria-label="Kept off the cloud">/);
  assert.match(k, /<span class="ui-tile-label">This month \(October\)<\/span><span class="ui-tile-value">about 4\.8M tokens<\/span><span class="ui-tile-note">about \$14\.46<\/span>/);
  assert.match(k, /<li><code>outline<\/code><span class="ui-fill"><\/span><span>about 2\.9M<\/span><span class="muted"> \(246 calls\)<\/span><\/li>/);
  assert.doesNotMatch(k, /Nothing counted yet/);
  const none = h.keptNone();
  assert.match(none, /aria-label="Kept out of your AI&#x27;s context"/);
  assert.doesNotMatch(none, /ui-kept-rows/);
  assert.match(none, /<p class="muted small">Nothing counted yet\.<\/p>/);
});

test('Needs you: a card each, its edge and badge its tone, its action at the end; a plain line when nothing needs you', () => {
  const n = h.needsYou();
  assert.match(n, /^<section class="ui-section ui-gap-md ui-needs" data-tour="needs-you" aria-label="Needs you">/);
  assert.match(n, /<div class="card ui-need ui-need-danger"><div class="ui-line"><span class="badge tone-danger">problem<\/span><strong>The round failed<\/strong><span class="muted small">gh is signed out\.<\/span><\/div><\/div>/);
  assert.match(n, /<div class="card ui-need ui-need-caution"><div class="ui-line"><span class="badge tone-caution">Settings<\/span><strong>A test command<\/strong><span class="ui-fill"><\/span><button type="button">Open Settings<\/button><\/div><\/div>/);
  assert.match(h.nothingNeeds(), /<p class="card muted">Nothing needs you right now\.<\/p><\/section>$/);
});

test("Needs you's heading is a Section's, so page.ts's h2 margin doesn't stack on the section's", () => {
  // A bare h2 in .ui-section-head took page.ts's 26px top margin on top of .ui-section's 22px; in .ui-section-name it
  // has none, as every Section's heading.
  const head = '<div class="ui-section-head"><div class="ui-section-name"><h2>Needs you</h2></div></div>';
  assert.ok(h.needsYou().includes(head));
  assert.ok(h.nothingNeeds().includes(head));
  assert.doesNotMatch(h.needsYou(), /ui-heading/, "the plain h2, as Section's");
});

test('what goes under Needs you without being a need: after the cards, or after the empty line, inside the section', () => {
  assert.match(h.needsAndMore(), /<strong>The round failed<\/strong><\/div><\/div><p class="muted small">No review queue yet\.<\/p><\/section>$/);
  assert.match(h.nothingAndMore(), /<p class="card muted">Nothing needs you right now\.<\/p><p class="muted small">No review queue yet\.<\/p><\/section>$/);
});

test('a row is one line, its details under it only once opened', () => {
  assert.equal(
    h.row(),
    '<div class="ui-list-row"><div class="ui-line"><span class="badge">failed</span><span class="ui-line-title">Heiward</span><span class="muted small ui-shrink">2 hours ago</span><span class="ui-fill"></span><button type="button">Output</button><button type="button" class="small quiet" aria-expanded="false">Details</button></div></div>',
  );
  assert.match(h.rowOpen(), /^<div class="ui-list-row ui-open">.*aria-expanded="true">Hide<\/button><\/div><div class="ui-line-more"><p>more<\/p><\/div><\/div>$/);
  assert.doesNotMatch(h.rowPlain(), /Details/, 'nothing more, no button');
});

test('long output goes in a panel beside the page, with its title, its lines and Close', () => {
  const p = h.panel();
  assert.match(p, /^<div class="ui-overlay"><aside class="ui-side-panel" role="dialog" aria-modal="true" aria-label="Heiward: unit tests">/);
  assert.match(p, /<div class="ui-side-head"><strong>Heiward: unit tests<\/strong><button type="button" class="quiet small">Close<\/button><\/div>/);
  assert.match(p, /<p class="muted small">exit 1, 2 hours ago<\/p><pre class="ui-output"><button type="button" class="ui-copy" title="Copy" aria-label="Copy all of it" aria-live="polite"><svg class="ui-icon"[^>]*><rect [^>]*><\/rect><path [^>]*><\/path><\/svg><span class="ui-copy-said">Copy<\/span><\/button>line 1\nline 2<\/pre>/, 'Copy first in the block, for all of it: the copy glyph, its word for a screen reader');
  assert.equal(h.paste(), '<div class="ui-paste"><pre aria-label="A command">echo hi</pre><button type="button" class="quiet small">Copy</button></div>');
});
