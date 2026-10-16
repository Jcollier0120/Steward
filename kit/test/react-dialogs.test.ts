import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The page's own dialogs and busy buttons (modal.tsx, busy.tsx): what they draw, how a question is answered, where
// Tab goes, and that no page code of the kit's asks the browser's alert(), confirm() or prompt() any more.
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
const { bundleForNode, importPath } = await import('./react-render.ts');

type Open = { kind: string; text: string; answer: (yes: boolean) => void }[];
const m = await bundleForNode<{
  host: () => string;
  html: Record<string, () => string>;
  confirmDialog: (text: string, o?: object) => Promise<boolean>;
  alertDialog: (text: string, o?: object) => Promise<void>;
  dialogsOpen: () => Open;
  nextStop: <T>(stops: T[], at: T | null, back: boolean) => T | null;
}>(
  `import { renderToStaticMarkup as r } from 'react-dom/server';
   import { alertDialog, BusyArea, BusyButton, Button, confirmDialog, DialogHost, dialogsOpen, nextStop } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
   export { alertDialog, confirmDialog, dialogsOpen, nextStop };
   export const host = () => r(<DialogHost />);
   export const html = {
     busyButton: () => r(<BusyButton className="btn" busy icon={<i>i</i>}>Check now</BusyButton>),
     idleButton: () => r(<BusyButton className="btn secondary" icon={<i>i</i>}>Check now</BusyButton>),
     plainBusy: () => r(<BusyButton busy>Save</BusyButton>),
     gated: () => r(<BusyButton disabled>Save</BusyButton>),
     busyArea: () => r(<BusyArea busy className="row" label="Updates"><button type="button">Update</button></BusyArea>),
     idleArea: () => r(<BusyArea><button type="button">Update</button></BusyArea>),
     button: () => r(<Button title="Save" onPress={() => Promise.resolve()} />),
   };`,
);

test('confirmDialog: the text, OK and Cancel, in an alertdialog that names its text; OK answers true', async () => {
  const asked = m.confirmDialog('Give this PC\'s place back?\n\nAnother PC can take it.');
  const h = m.host();
  assert.match(h, /^<div class="ui-modal ui-dialog"><div class="ui-modal-card ui-dialog-card" role="alertdialog" aria-modal="true" aria-label="Question" aria-describedby="([^"]+)" tabindex="-1"/);
  const id = h.match(/aria-describedby="([^"]+)"/)![1];
  assert.match(h, new RegExp(`<p class="ui-dialog-text" id="${id}">Give this PC&#x27;s place back\\?\n\nAnother PC can take it\\.</p>`), 'its words as they were, paragraphs kept');
  assert.match(h, /<div class="ui-dialog-actions"><button type="button" data-autofocus="">OK<\/button><button type="button" class="quiet">Cancel<\/button><\/div>/, 'OK first and focused, as the browser had it; then Cancel');
  m.dialogsOpen()[0].answer(true);
  assert.equal(await asked, true);
  assert.equal(m.host(), '', 'answered: gone');
});

test('confirmDialog: Cancel (or Escape, which answers as Cancel) is false', async () => {
  const asked = m.confirmDialog('Fire Reeve?');
  m.dialogsOpen()[0].answer(false);
  assert.equal(await asked, false);
});

test('alertDialog: the message and OK alone; questions asked together come one at a time, oldest first', async () => {
  const first = m.alertDialog('The Steward did it.');
  const second = m.confirmDialog('And this?', { ok: 'Fire', cancel: 'Keep', danger: true, title: 'Fire Reeve' });
  let h = m.host();
  assert.match(h, /aria-label="Message"/);
  assert.match(h, />The Steward did it\.<\/p><div class="ui-dialog-actions"><button type="button" data-autofocus="">OK<\/button><\/div>/);
  assert.doesNotMatch(h, /Cancel|And this/);
  m.dialogsOpen()[0].answer(true);
  assert.equal(await first, undefined);
  h = m.host();
  assert.match(h, /aria-label="Fire Reeve"/);
  assert.match(h, /<h2 class="ui-dialog-title">Fire Reeve<\/h2>/);
  assert.match(h, /<button type="button" class="ui-danger" data-autofocus="">Fire<\/button><button type="button" class="quiet">Keep<\/button>/);
  m.dialogsOpen()[0].answer(true);
  assert.equal(await second, true);
  assert.deepEqual(m.dialogsOpen(), []);
});

test('the focus trap: Tab from the last goes round to the first, Shift+Tab from the first to the last, from the card in', () => {
  const stops = ['ok', 'cancel', 'link'];
  assert.equal(m.nextStop(stops, 'link', false), 'ok');
  assert.equal(m.nextStop(stops, 'ok', true), 'link');
  assert.equal(m.nextStop(stops, null, false), 'ok', 'from the card itself: the first');
  assert.equal(m.nextStop(stops, null, true), 'link');
  assert.equal(m.nextStop(stops, 'outside', false), 'ok', 'from anywhere outside: back in');
  assert.equal(m.nextStop(stops, 'ok', false), null, "inside, between two: the browser's own Tab");
  assert.equal(m.nextStop([], null, false), null);
});

test('BusyButton: its own classes, a spinner in place of its icon, aria-busy and no presses while busy', () => {
  assert.equal(m.html.busyButton(), '<button type="button" class="btn" disabled="" aria-busy="true"><span class="ui-spinner" style="width:14px;height:14px" aria-hidden="true"></span>Check now</button>');
  assert.equal(m.html.idleButton(), '<button type="button" class="btn secondary"><i>i</i>Check now</button>');
  assert.match(m.html.plainBusy(), /^<button type="button" disabled="" aria-busy="true"><span class="ui-spinner"[^>]*><\/span>Save<\/button>$/, 'a spinner before the words when it has no icon');
  assert.equal(m.html.gated(), '<button type="button" disabled="">Save</button>', 'disabled is not busy');
});

test('BusyArea: a fieldset, disabled and aria-busy while its work runs; plain at rest', () => {
  assert.equal(m.html.busyArea(), '<fieldset class="ui-busy-area row" disabled="" aria-busy="true" aria-label="Updates"><button type="button">Update</button></fieldset>');
  assert.equal(m.html.idleArea(), '<fieldset class="ui-busy-area"><button type="button">Update</button></fieldset>');
});

test("Button: an onPress that returns a promise is still a plain button at rest (it spins once pressed)", () => {
  assert.equal(m.html.button(), '<button type="button">Save</button>');
});

test("no page code of the kit's asks the browser's alert(), confirm() or prompt(): it's the page's own dialog", () => {
  const kit = path.join(STEWARD, 'kit');
  const files = [
    ...readdirSync(path.join(kit, 'react')).map((f) => path.join(kit, 'react', f)),
    ...readdirSync(path.join(kit, 'web')).filter((f) => f.endsWith('.js')).map((f) => path.join(kit, 'web', f)),
    path.join(kit, 'node', 'page.ts'),
    path.join(kit, 'node', 'react-page.ts'),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /(?<![\w.])(?:window\.)?(?:alert|confirm|prompt)\(\s*[^)\s]/, `${path.relative(kit, file)} asks the browser`);
  }
});

test("page.ts's script: its own dialog for data-confirm and the server's words, and a spinner in the button that waits", () => {
  const page = readFileSync(path.join(STEWARD, 'kit', 'node', 'page.ts'), 'utf8');
  assert.match(page, /if \(question && !\(await ask\(question, true\)\)\) return;/);
  assert.match(page, /act\(b\.dataset\.post, data, b\.dataset\.confirm, b\);/);
  assert.match(page, /spin\.className = 'ui-spinner';/);
  assert.match(page, /\.ui-dialog, button\[aria-busy\]'\);/, "the page doesn't reload itself under a dialog or a button that waits");
  const css = page.slice(page.indexOf('export const CSS = `'));
  for (const cls of ['.ui-spinner', '.ui-modal', '.ui-modal-card', '.ui-modal.ui-dialog', '.ui-dialog-text', '.ui-dialog-actions']) assert.ok(css.includes(`\n${cls} {`), `the page's CSS draws ${cls}, for both kinds of page`);
});
