#!/usr/bin/env node
/**
 * Spins up the sample repositories of samples/pipelines (tools/lib/samples.ts): hello, world on Node.js, Python, Rust,
 * .NET and Go, one on this PC alone, one on a fake GitLab, one released to a folder, and one whose .steward.json is
 * wrong on purpose, each a clone the Steward can look after.
 *
 *   node tools/samples.ts [<folder>] [--only node-hello,go-hello]
 *
 * <folder> is C:\Projects\pipeline-samples by default (%USERPROFILE%\pipeline-samples with no C:\Projects). One there
 * already is left as it is. Nothing is asked of any host, and nothing is looked after: add them yourself (docs/PIPELINE.md).
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spinUp } from './lib/samples.ts';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]?.split(',') : undefined;
const folder = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') ?? (existsSync('C:\\Projects') ? 'C:\\Projects\\pipeline-samples' : path.join(os.homedir(), 'pipeline-samples'));
const spun = spinUp(folder, { only });
for (const s of spun) console.log(s.left ? `- ${s.name}: ${s.left}` : `- ${s.name}: ${s.dir}${s.origin ? `, its origin ${s.origin}` : ', no origin (this PC alone)'}`);
console.log(`
Each one's steps, nothing run:   node src/cli.ts build --dry-run "${path.join(path.resolve(folder), (spun.find((s) => s.name === 'python-hello') ?? spun[0])?.name ?? 'python-hello')}"
Look after one: on the Steward's page, Found on this PC (Look again), or "Add a clone by its folder".
Its releases go to its origin in ${path.join(path.resolve(folder), '.origins')}, or (folder releases) ${path.join(path.resolve(folder), 'releases')}.`);
