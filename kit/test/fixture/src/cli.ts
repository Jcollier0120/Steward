#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { APP, port } from './app.ts';
import { installCli } from './kit/install.ts';
import { page, settingsPanel } from './kit/page.ts';
import { serve } from './kit/server.ts';
import { open, shutdown, start, status, stop } from './kit/service.ts';
import { SETTINGS_SPEC } from './settings.ts';

/** The fixture's commands: the ones every agent has, and a page with nothing on it but Settings. */
const [cmd, ...rest] = process.argv.slice(2);
const cliFile = fileURLToPath(import.meta.url);
switch (cmd) {
  case 'serve':
    await serve({
      port,
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>',
      get: { '/': ({ token }) => ({ html: page({ token, body: `<h2>Settings</h2>${settingsPanel()}` }) }) },
      settings: SETTINGS_SPEC,
    });
    console.log(`${APP.name} is serving http://${APP.id}.localhost:${port}/`);
    break;
  case 'start':
    process.exitCode = await start(cliFile);
    break;
  case 'stop':
    process.exitCode = await stop();
    break;
  case 'open':
    process.exitCode = await open(cliFile);
    break;
  case 'shutdown':
    process.exitCode = await shutdown();
    break;
  case 'status':
    process.exitCode = await status(rest.includes('--json'));
    break;
  case 'install':
  case 'uninstall':
    process.exitCode = await installCli(cmd, rest);
    break;
  default:
    console.log(`${APP.id}: ${APP.role}\n  serve | start | stop | open | shutdown | status [--json] | install | uninstall`);
    process.exitCode = cmd && cmd !== 'help' ? 2 : 0;
}
