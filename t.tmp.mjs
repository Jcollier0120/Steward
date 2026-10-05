import fs from 'node:fs';
const p = 'kit/test/react-page.test.ts';
const raw = fs.readFileSync(p, 'utf8'); const EOL = raw.includes('\r\n') ? '\r\n' : '\n';
let s = raw.split('\r\n').join('\n');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70)); s = s.replace(a, b); };
rep("       <Page data={data} reload={() => {}} action={<PostButton quiet path=\"/api/run\" confirm=\"Now?\">Run now</PostButton>}>\n         <Card className=\"empty\"><Muted>quiet</Muted> <Badge kind=\"ok\">fine</Badge></Card>",
    "       <Page data={data} reload={() => {}} action={<PostButton quiet path=\"/api/run\" confirm=\"Now?\">Run now</PostButton>} tour={<p>Step one</p>}>\n         <Card className=\"empty\" tour=\"mine\"><Muted>quiet</Muted> <Badge kind=\"ok\">fine</Badge></Card>");
rep('<span class="titlebar-action"><button type="button" class="quiet" data-post="\/api\/run">Run now<\/button><\/span>/);',
    '<span class="titlebar-action" data-tour="action"><button type="button" class="quiet" data-post="\/api\/run">Run now<\/button><\/span>/);');
rep('assert.match(html, /<div class="card empty"><span class="muted">quiet<\/span> <span class="badge ok">fine<\/span><\/div>/);',
    'assert.match(html, /<div class="card empty" data-tour="mine"><span class="muted">quiet<\/span> <span class="badge ok">fine<\/span><\/div>/);');
rep("  assert.match(html, /<footer>[^<]+ · this PC only · its files are in <code>/);\n});",
    "  assert.match(html, /<footer>[^<]+ · this PC only · its files are in <code>/);\n" +
    "  // Room for the onboarding tour: every part of the frame named, and the tour drawn over the page only at #/tour.\n" +
    "  for (const name of ['titlebar', 'status', 'settings', 'theme', 'action', 'settings-panel', 'work']) assert.match(html, new RegExp(`data-tour=\"${name}\"`), name);\n" +
    "  assert.doesNotMatch(html, /tour-layer/);\n" +
    "  (globalThis as { location: { hash: string } }).location.hash = '#/tour';\n" +
    "  assert.match(render({ shell, body: {} }), /<div class=\"tour-layer\" role=\"dialog\" aria-label=\"A tour of [^\"]+'s page\"><p>Step one<\/p><\/div>/);\n" +
    "});\n\n" +
    "test(\"a ping's round state: news when a round starts or ends, not when nothing changed\", async () => {\n" +
    "  const { roundState } = await import('../react/page-data.ts');\n" +
    "  const idle = roundState({ busy: false, lastRunAt: '2026-10-05T12:00:00Z', runningSince: null });\n" +
    "  assert.equal(roundState({ busy: false, lastRunAt: '2026-10-05T12:00:00Z' }), idle, 'the same state, said either way');\n" +
    "  assert.notEqual(roundState({ busy: true, lastRunAt: '2026-10-05T12:00:00Z', runningSince: '2026-10-05T12:10:00Z' }), idle, 'one started');\n" +
    "  assert.notEqual(roundState({ busy: false, lastRunAt: '2026-10-05T12:10:30Z' }), idle, 'one ended');\n" +
    "});");
fs.writeFileSync(p, s.split('\n').join(EOL));
console.log('ok');
