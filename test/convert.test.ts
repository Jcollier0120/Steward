import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { convert, convertReadme, kitScripts } from '../src/convert.ts';
import { run } from '../src/run.ts';
import { fakeEmployee, sh } from './helpers.ts';

// Converting a hire that carries its own copy of the kit to the Steward's, on a fake hire made with git.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-convert-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a hire is converted: the old kit gone, its imports in src/kit, kit.json, tools/kit.ts, scripts, version and README', async () => {
  const f = fakeEmployee(path.join(tmp, 'hire'), {
    version: '0.3.1',
    kit: null,
    files: {
      'src/npu.ts': 'export class Npu {}\n',
      'src/server.ts': "import { APP } from './app.ts';\n",
      'src/settings-panel.js': '// panel\n',
      'tools/release.ts': '// release\n',
      'test/kit.test.ts': '// the old kit test\n',
      'src/agent.ts': "import { Npu } from './npu.ts';\nimport { serve } from './server.ts';\nimport { APP } from './app.ts';\n",
      'src/watch/index.ts': "export { Npu } from '../npu.ts';\n",
      'test/agent-own.test.ts': "const { Npu } = await import('../src/npu.ts');\n",
      'README.md': "# Fake\n\nIt goes through the house kit's [src/npu.ts](src/npu.ts), and the queue is Reeve's `docs/NPU-QUEUE.md`.\n\n## Development\n\nnpm test\n",
    },
  });
  sh(f.checkout, 'checkout', '--quiet', '-b', 'steward/use-kit-1.0.0');
  // package.json needs scripts to rewrite.
  const pkg = JSON.parse(readFileSync(path.join(f.checkout, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.3.1');
  const r = await convert({ dir: f.checkout, kit: '1.0.0', parts: ['node', 'web', 'spec'], version: '0.4.0', kitTool: '// tools/kit.ts\n', run });
  assert.deepEqual(r.removed, ['src/npu.ts', 'src/server.ts', 'src/settings-panel.js', 'test/kit.test.ts', 'tools/release.ts']);
  assert.equal(r.from, '0.3.1');
  const read = (p: string) => readFileSync(path.join(f.checkout, p), 'utf8');
  assert.equal(read('src/agent.ts'), "import { Npu } from './kit/npu.ts';\nimport { serve } from './kit/server.ts';\nimport { APP } from './app.ts';\n");
  assert.equal(read('src/watch/index.ts'), "export { Npu } from '../kit/npu.ts';\n");
  assert.equal(read('test/agent-own.test.ts'), "const { Npu } = await import('../src/kit/npu.ts');\n");
  assert.equal(read('kit.json'), '{\n  "kit": "1.0.0",\n  "parts": ["node", "web", "spec"]\n}\n');
  assert.equal(read('tools/kit.ts'), '// tools/kit.ts\n');
  assert.match(read('test/agent.test.ts'), /import '\.\.\/src\/kit\/agent-checks\.ts';/);
  assert.match(read('.gitignore'), /^src\/kit\/$/m);
  assert.equal(read('.gitignore').match(/src\/kit\//g)!.length, 1, 'once');
  assert.equal(JSON.parse(read('package.json')).version, '0.4.0');
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].version, '0.4.0');
  assert.match(read('src/app.ts'), /version: '0\.4\.0'/);
  const readme = read('README.md');
  assert.match(readme, /\[src\/kit\/npu\.ts\]\(https:\/\/github\.com\/Jcollier0120\/Steward\/blob\/main\/kit\/node\/npu\.ts\)/);
  assert.match(readme, /the kit's \[spec\/NPU-QUEUE\.md\]/);
  assert.ok(readme.indexOf('## The kit') < readme.indexOf('## Development'));
  // Everything is staged, nothing committed.
  assert.equal(sh(f.checkout, 'status', '--porcelain').split('\n').filter((l) => !/^[MADR] /.test(l)).length, 0);
  assert.ok(!existsSync(path.join(f.checkout, 'tools', 'release.ts')));
  await assert.rejects(convert({ dir: f.checkout, kit: '1.0.0', parts: ['node'], version: '0.4.1', kitTool: '', run }), /tracks none of the old kit's files/);
});

test("npm's scripts fill the kit first: kit, pretest, pretypecheck, serve and release", () => {
  const s = kitScripts({ serve: 'node src/cli.ts serve', start: 'node src/cli.ts start', test: 'node --test "test/**/*.test.ts"', typecheck: 'tsc -p .', release: 'node tools/release.ts' });
  assert.deepEqual(Object.keys(s), ['kit', 'serve', 'start', 'pretest', 'test', 'pretypecheck', 'typecheck', 'release']);
  assert.equal(s.serve, 'node tools/kit.ts && node src/cli.ts serve');
  assert.equal(s.release, 'node tools/kit.ts && node src/kit/release.ts');
  assert.equal(s.pretest, 'node tools/kit.ts');
  assert.deepEqual(kitScripts(s), s, 'converting twice changes nothing');
});

test('a README without a Development section gets the kit at its end; one with the section already is left as it is', () => {
  assert.match(convertReadme('# X\n\nText.\n', 'X'), /Text\.\n\n## The kit\n\n[\s\S]*agent interface in the Steward's README\)\.\n$/);
  const done = convertReadme('# X\n\n## The kit\n\nAlready.\n', 'X');
  assert.equal(done, '# X\n\n## The kit\n\nAlready.\n');
});
