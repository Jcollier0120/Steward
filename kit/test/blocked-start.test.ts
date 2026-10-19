import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'kit-blocked-start-'));
after(() => rmSync(home, { recursive: true, force: true }));

const A = await import('./fixture/src/kit/accelerators.ts');

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

// Smart App Control blocking a file in the server's folder (node's, here), as the Code Integrity log gives it.
const blocked = async () =>
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-CodeIntegrity'/><EventID>3077</EventID><TimeCreated SystemTime='${new Date().toISOString()}'/></System><EventData><Data Name='File Name'>\\Device\\HarddiskVolume3${path.dirname(process.execPath).replace(/^[a-z]:/i, '')}\\ggml-cpu-ivybridge.dll</Data><Data Name='PolicyName'>VerifiedAndReputableDesktop</Data></EventData></Event>`;

// A server that counts its starts in `marker`, exits at once for the first `failures` of them, then answers.
const server = (marker: string, port: number, failures: number) => [
  process.execPath,
  '-e',
  `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');if(fs.readFileSync(${JSON.stringify(marker)},'utf8').length<=${failures})process.exit(1);require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end('{"data":[{"id":"m"}]}')}).listen(${port},'127.0.0.1');setTimeout(()=>process.exit(0),8000)`,
];

test('a server Smart App Control blocked part of is started once more, and serves', { skip: process.platform !== 'win32' }, async () => {
  const port = await freePort();
  const marker = path.join(home, 'once');
  const ep = { baseUrl: `http://127.0.0.1:${port}`, model: 'm', startCommand: server(marker, port, 1) };
  const logFile = path.join(home, 'once.log');
  assert.deepEqual(await A.ensureServer(ep, { waitMs: 5000, logFile, readBlocks: blocked }), { started: true, waited: false });
  assert.equal(readFileSync(marker, 'utf8'), 'xx', 'started twice');
  assert.match(readFileSync(logFile, 'utf8'), /Smart App Control blocked ggml-cpu-ivybridge\.dll, part of node\.exe.*It's started once more in 2 s\./);
});

test('a server blocked again says so, as before, after two starts; one that just exits is started only once', { skip: process.platform !== 'win32' }, async () => {
  const port = await freePort();
  const twice = path.join(home, 'twice');
  await assert.rejects(A.ensureServer({ baseUrl: `http://127.0.0.1:${port}`, model: 'm', startCommand: server(twice, port, 9) }, { waitMs: 5000, logFile: path.join(home, 'twice.log'), readBlocks: blocked }), (e: Error) => e instanceof A.AcceleratorDown && /^Windows' Smart App Control blocked ggml-cpu-ivybridge\.dll, part of node\.exe: .*exited/.test(e.message));
  assert.equal(readFileSync(twice, 'utf8'), 'xx', 'started twice, no more');
  const plain = path.join(home, 'plain');
  await assert.rejects(A.ensureServer({ baseUrl: `http://127.0.0.1:${port}`, model: 'm', startCommand: server(plain, port, 9) }, { waitMs: 5000, readBlocks: async () => null }), (e: Error) => e instanceof A.AcceleratorDown && !/Smart App Control/.test(e.message));
  assert.equal(readFileSync(plain, 'utf8'), 'x', 'nothing blocked: no second try');
});
