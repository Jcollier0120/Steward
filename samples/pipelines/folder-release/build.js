// The build: dist/hello.txt, with the version it was built at.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
mkdirSync('dist', { recursive: true });
writeFileSync('dist/hello.txt', `Hello, world! (folder-release ${version})\n`);
console.log(`built dist/hello.txt at ${version}`);
