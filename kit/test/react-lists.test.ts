import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The react part's OnPageList: a list kept with buttons on the page (lists.tsx), each entry with its Remove.
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
const { bundleForNode, importPath } = await import('./react-render.ts');

const m = await bundleForNode<{ list: (items: unknown[], more?: object) => string }>(
  `import { renderToStaticMarkup as r } from 'react-dom/server';
   import { OnPageList } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
   export const list = (items, more = {}) => r(<OnPageList title="Trusted" items={items} remove="/api/trust/remove" noun="program" empty="Nothing trusted yet." tour="trusted" {...more} />);`,
);

test('each entry with its Remove, which posts which one; the count in the heading', () => {
  const h = m.list([{ id: 'C:\Tools\a.exe', label: 'a.exe', detail: 'Trusted on 5 October' }, { id: 'b', label: 'b.exe' }]);
  assert.match(h, /<section class="ui-section ui-gap-md" data-tour="trusted">.*<h2>Trusted<\/h2><span class="muted ui-count">· 2<\/span>/);
  assert.match(h, /<div class="card ui-onpage-list"><ul><li><div class="ui-onpage-what"><span>a\.exe<\/span><div class="muted">Trusted on 5 October<\/div><\/div>/);
  assert.match(h, /aria-label="Remove program 1"[^>]*data-post="\/api\/trust\/remove"/);
  assert.match(h, /aria-label="Remove program 2"/);
  assert.equal(h.match(/>Remove</g)?.length, 2);
});

test('nothing in it: the empty note, and no list', () => {
  const h = m.list([], { help: 'Programs you trusted from a note.' });
  assert.match(h, /<p class="muted">Programs you trusted from a note\.<\/p>/);
  assert.match(h, /<p class="muted ui-empty-note">Nothing trusted yet\.<\/p>/);
  assert.doesNotMatch(h, /ui-onpage-list/);
});
