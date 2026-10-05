import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The react part's components, on GamerNexus's UI kit API (apps/mobile/components/ui) in the manor's look: their
// props, variants and states, rendered with react-dom/server. What a page draws from them, not how they look.
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
const { bundleForNode, importPath } = await import('./react-render.ts');

const ui = await bundleForNode<{ html: Record<string, () => string> }>(
  `import { renderToStaticMarkup as r } from 'react-dom/server';
   import { Badge, Button, Card, CardFooter, ChoiceGroup, DetailRow, EmptyNote, ErrorNote, Input, Loading, ModalCard, QueryView, SaveStatus, Section, Segmented, Select, Switch, Text, Toast } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
   const q = (o) => ({ data: undefined, isLoading: false, isError: false, error: null, ...o });
   export const html = {
     text: () => r(<>{['title', 'heading', 'body', 'muted', 'label'].map((v) => <Text key={v} variant={v}>{v}</Text>)}</>),
     buttons: () => r(<>{['primary', 'secondary', 'ghost', 'danger', 'danger-quiet'].map((v) => <Button key={v} title={v} variant={v} />)}<Button title="small" size="sm" /><Button title="large" size="lg" /></>),
     busy: () => r(<Button title="Saving" loading icon="refresh" />),
     gated: () => r(<Button title="Upgrade" disabledLook tooltip="Premium only" />),
     iconed: () => r(<Button title="Refresh" variant="secondary" icon="refresh" />),
     badges: () => r(<>{['neutral', 'info', 'success', 'premium', 'caution', 'danger', 'night', 'subscription', 'host'].map((t) => <Badge key={t} label={t} tone={t} />)}</>),
     section: () => r(<Section title="Platforms" count={3} right={<Badge label="new" tone="info" />} gap="lg" tour="platforms"><Card>x</Card></Section>),
     pressable: () => r(<Card onPress={() => {}}>tap</Card>),
     footer: () => r(<Card>body<CardFooter className="row">actions</CardFooter></Card>),
     detail: () => r(<><DetailRow icon="time" text="Tonight" /><DetailRow icon="open" text="Open it" link fill /></>),
     input: () => r(<Input label="Name" value="Porter" onChangeText={() => {}} error="Too short" clearable busy />),
     select: () => r(<Select label="Theme" value={2} options={[{ label: 'One', value: 1 }, { label: 'Two', value: 2, hint: 'dark' }]} onChange={() => {}} />),
     unpicked: () => r(<Select value={null} options={[{ label: 'One', value: 1 }]} onChange={() => {}} />),
     switch: () => r(<Switch value onValueChange={() => {}} accessibilityLabel="Notes" />),
     segmented: () => r(<Segmented options={[{ value: 'a', label: 'All' }, { value: 'r', label: 'Recent' }]} value="r" onChange={() => {}} />),
     choices: () => r(<ChoiceGroup layout="stack" options={[{ value: true, label: 'Online' }, { value: false, label: 'Local', disabled: true, right: <Badge label="soon" /> }]} value={true} onChange={() => {}} />),
     saving: () => r(<SaveStatus pending saved={false} />),
     saved: () => r(<SaveStatus pending={false} saved />),
     rest: () => r(<SaveStatus pending={false} saved={false} />),
     loading: () => r(<Loading />),
     error: () => r(<ErrorNote message="No answer" onRetry={() => {}} />),
     empty: () => r(<EmptyNote message="Nothing yet" />),
     qData: () => r(<QueryView query={q({ data: { n: 2 }, isLoading: true, isError: true, error: { message: 'x' } })}>{(d) => <b>{d.n}</b>}</QueryView>),
     qError: () => r(<QueryView query={q({ isError: true, error: { message: 'Down' }, refetch: () => {} })}>{() => null}</QueryView>),
     qPaused: () => r(<QueryView query={q({ isLoading: true, fetchStatus: 'paused' })}>{() => null}</QueryView>),
     qLoading: () => r(<QueryView query={q({ isLoading: true })}>{() => null}</QueryView>),
     qEmpty: () => r(<QueryView query={q({})} emptyMessage="None">{() => null}</QueryView>),
     toast: () => r(<Toast message="Copied" onHide={() => {}} />),
     noToast: () => r(<Toast message={null} onHide={() => {}} />),
     modal: () => r(<ModalCard visible onClose={() => {}} label="Edit">inside</ModalCard>),
     hidden: () => r(<ModalCard visible={false} onClose={() => {}}>inside</ModalCard>),
   };`,
);
const h = ui.html;

test("Text: GamerNexus's five variants, on the manor's classes", () => {
  assert.equal(h.text(), '<span class="ui-title">title</span><span class="ui-heading">heading</span><span>body</span><span class="muted">muted</span><span class="ui-label">label</span>');
});

test("Button: five weights on the manor's buttons, three sizes, busy, gated, and an icon at the house size", () => {
  const b = h.buttons();
  assert.match(b, /<button type="button">primary<\/button>/, "primary is the manor's filled button");
  assert.match(b, /<button type="button" class="quiet">secondary<\/button>/);
  assert.match(b, /class="ui-ghost">ghost/);
  assert.match(b, /class="ui-danger">danger</);
  assert.match(b, /class="quiet ui-danger-quiet">danger-quiet/);
  assert.match(b, /class="small">small/);
  assert.match(b, /class="ui-lg">large/);
  assert.match(h.busy(), /<button type="button" disabled="" aria-busy="true"><span class="ui-spinner"/, 'busy: a spinner in place of the icon, and no presses');
  assert.match(h.gated(), /<button type="button" class="ui-dimmed" aria-disabled="true" title="Premium only">Upgrade<\/button>/, 'looks disabled, still takes presses');
  assert.match(h.iconed(), /<svg class="ui-icon" viewBox="0 0 16 16" width="16" height="16"/);
});

test("Badge: GamerNexus's nine tones", () => {
  for (const t of ['neutral', 'info', 'success', 'premium', 'caution', 'danger', 'night', 'subscription', 'host']) assert.match(h.badges(), new RegExp(`<span class="badge tone-${t}">${t}</span>`));
});

test('Section, Card, CardFooter and DetailRow', () => {
  assert.equal(
    h.section(),
    '<section class="ui-section ui-gap-lg" data-tour="platforms"><div class="ui-section-head"><div class="ui-section-name"><h2>Platforms</h2><span class="muted ui-count">· 3</span></div><div class="ui-section-right"><span class="badge tone-info">new</span></div></div><div class="card">x</div></section>',
  );
  assert.match(h.pressable(), /<div class="card ui-pressable" role="button" tabindex="0">tap<\/div>/, 'a Card with onPress is a button, reachable by keyboard');
  assert.match(h.footer(), /<div class="card">body<div class="ui-card-footer row">actions<\/div><\/div>/);
  assert.match(h.detail(), /<div class="ui-detail-row"><svg[^>]*>.*<\/svg><span class="muted ui-shrink">Tonight<\/span><\/div>/);
  assert.match(h.detail(), /<div class="ui-detail-row ui-link">.*<span class="muted ui-fill">Open it<\/span>/);
});

test('the form controls: Input, Select, Switch, Segmented, ChoiceGroup, SaveStatus', () => {
  const i = h.input();
  assert.match(i, /<label class="ui-label" for="[^"]+">Name<\/label>/);
  assert.match(i, /<div class="ui-field ui-error"><input id="[^"]+" type="text" aria-invalid="true" value="Porter"\/>/);
  assert.match(i, /<span class="ui-spinner"/, 'busy');
  assert.match(i, /aria-label="Clear text"/, 'clearable, with text in it');
  assert.match(i, /<span class="ui-error-text">Too short<\/span>/);
  assert.match(h.select(), /<option value="1" title="dark" selected="">Two \(dark\)<\/option>/);
  assert.match(h.unpicked(), /<option value="" disabled="" selected="">Select…<\/option>/, 'nothing picked: the placeholder');
  assert.match(h.switch(), /<input type="checkbox" role="switch" class="ui-switch" aria-label="Notes" checked=""\/>/);
  assert.match(h.segmented(), /<button type="button" role="tab" aria-selected="false">All<\/button><button type="button" role="tab" aria-selected="true" class="ui-on">Recent<\/button>/);
  const c = h.choices();
  assert.match(c, /<div class="ui-choices ui-stack" role="radiogroup">/);
  assert.match(c, /role="radio" aria-checked="true" class="ui-choice ui-on"><span class="ui-fill">Online/);
  assert.match(c, /aria-checked="false" disabled="" class="ui-choice"><span class="ui-fill">Local<\/span><span class="badge tone-neutral">soon<\/span>/, 'a stack option carries its badge; a disabled one is shown');
  assert.match(h.saving(), /Saving…/);
  assert.match(h.saved(), /class="ui-save ui-saved"/);
  assert.equal(h.rest(), '', 'nothing at rest');
});

test("the states, and QueryView's order: data, else the error, else offline, else loading, else empty", () => {
  assert.match(h.loading(), /role="status" aria-label="Loading"/);
  assert.match(h.error(), /Something went wrong.*No answer.*Try again/);
  assert.match(h.empty(), /<p class="muted ui-empty-note">Nothing yet<\/p>/);
  assert.equal(h.qData(), '<b>2</b>', 'data first, even mid-refetch and after an error');
  assert.match(h.qError(), /Down.*Try again/, 'an error, with the way back');
  assert.match(h.qPaused(), /offline/, 'paused offline: said, not spun');
  assert.match(h.qLoading(), /ui-spinner/);
  assert.match(h.qEmpty(), /None/);
});

test('Toast and ModalCard: shown only when there is something to show', () => {
  assert.match(h.toast(), /<div class="ui-toast" role="status"><span>Copied<\/span><\/div>/);
  assert.equal(h.noToast(), '');
  assert.match(h.modal(), /<div class="ui-modal"><div class="ui-modal-card" role="dialog" aria-modal="true" aria-label="Edit" tabindex="-1"/);
  assert.equal(h.hidden(), '');
});
