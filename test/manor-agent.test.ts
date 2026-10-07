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

// Manor's registry skips an entry whose role is longer than 120 characters (its src/registry.ts), so the Steward
// would have no Hire on its card. The page says the same role (APP.role).
test("every role in manor-agent.json is at most 120 characters, and the agent's is APP.role", () => {
  const json = JSON.parse(readFileSync(new URL('../manor-agent.json', import.meta.url), 'utf8'));
  const roles: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'role' && typeof x === 'string' ? roles.push(x) : walk(x));
  };
  walk(json);
  assert.ok(roles.length > 0, 'the agent has a role');
  for (const role of roles) assert.ok(role.length <= 120, `"${role}" is ${role.length} characters; Manor takes at most 120`);
  assert.equal(json.agent.role, APP.role);
});
