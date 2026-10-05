import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { APP } from '../src/app.ts';
import { checkAnnouncement } from '../src/kit/release.ts';

// manor-agent.json is published with every release (the kit's release.ts), so Manor offers Hire on its role's card.
test('manor-agent.json is an entry Manor takes for this agent, from its own repository, with its role', () => {
  const json = JSON.parse(readFileSync(new URL('../manor-agent.json', import.meta.url), 'utf8'));
  assert.equal(checkAnnouncement(json, APP.id, 'Jcollier0120/Steward'), null);
  assert.equal(json.agent.name, APP.name);
  for (const role of json.agent.fills) assert.ok(json.roles.some((r: { id: string }) => r.id === role), `it brings its role ${role}`);
});
