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
   import { ConnectAI, Glance, Kept, Output, Paste, SidePanel, StaffLayout } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
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
     kept: () => r(<Kept intro="Tokens Reeve read" stats={[{ label: 'This month (October)', value: 'about 4.8M tokens', note: 'about $14.46' }]} rows={[{ name: 'outline', value: 'about 2.9M', note: '(246 calls)' }]} counted empty="Nothing counted yet." footnote="Estimates." />),
     keptNone: () => r(<Kept title="Kept out of your AI's context" stats={[{ label: 'All time', value: 'None yet' }]} rows={[{ name: 'check', value: '0' }]} counted={false} empty="Nothing counted yet." />),
     panel: () => r(<SidePanel title="Heiward: unit tests" meta={['exit 1, 2 hours ago']} onClose={() => {}}><Output text={'line 1\\nline 2'} /></SidePanel>),
     paste: () => r(<Paste text="echo hi" label="A command" />),
     needs: () => r(<StaffLayout needs needsYou={<i>needs</i>} glance={<b>glance</b>} connect={<u>connect</u>} kept={<s>kept</s>}><em>own</em></StaffLayout>),
     calm: () => r(<StaffLayout needsYou={<i>needs</i>} glance={<b>glance</b>}><em>own</em></StaffLayout>),
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

test('long output goes in a panel beside the page, with its title, its lines and Close', () => {
  const p = h.panel();
  assert.match(p, /^<div class="ui-overlay"><aside class="ui-side-panel" role="dialog" aria-modal="true" aria-label="Heiward: unit tests">/);
  assert.match(p, /<div class="ui-side-head"><strong>Heiward: unit tests<\/strong><button type="button" class="quiet small">Close<\/button><\/div>/);
  assert.match(p, /<p class="muted small">exit 1, 2 hours ago<\/p><pre class="ui-output">line 1\nline 2<\/pre>/);
  assert.equal(h.paste(), '<div class="ui-paste"><pre aria-label="A command">echo hi</pre><button type="button" class="quiet small">Copy</button></div>');
});
