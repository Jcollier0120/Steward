// Draws the text reader's check pictures (kit/node/ocr-check.ts) into a folder with truth.json ({file, set, group,
// lines}), for train.py and run.py to score against: node tools/ocr-model/fixtures.ts <dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { drawBrowser, drawGdi, findEdge } from '../../kit/node/ocr-check.ts';

const dir = path.resolve(process.argv[2]);
mkdirSync(dir, { recursive: true });
const gdi = await drawGdi(dir);
const edge = findEdge();
const browser = edge ? await drawBrowser(dir, edge) : [];
const all = [...gdi, ...browser].map((f) => ({ file: path.basename(f.file), set: f.set, group: f.group, lines: f.lines }));
writeFileSync(path.join(dir, 'truth.json'), JSON.stringify(all, null, 1));
console.log(all.length, 'pictures,', all.reduce((n, f) => n + f.lines.length, 0), 'lines');
