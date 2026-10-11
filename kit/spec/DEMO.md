# Demo mode: an agent's page with made-up data

Manor shows a picture of each employee's page in its entry (the hire popup, and the role's own page) instead of the office's initial. Those pictures ship to everyone, so they must never show anyone's own files, mail, repositories or folders: they are taken in demo mode, from data the agent's maintainer makes up.

## Running one

From a checkout, with an empty data folder and a free port:

```
set FIXTURE_HOME=%TEMP%\demo-fixture
set FIXTURE_PORT=48686
set KIT_DEMO=1
node src\cli.ts <the command that serves its page>
```

(`<ID>_HOME` and `<ID>_PORT` with the agent's id in capitals.) `KIT_DEMO=1` is the agent's own `demo` folder; `KIT_DEMO=<folder>` another.

In demo mode the page server (node/server.ts, node/demo.ts):

- answers a GET from the demo folder where it has a file for it: `/api/state` from `demo/api/state.json`, `/api/findings` from `demo/api/findings.json`. The query is ignored.
- answers the rest with the agent's own handlers, which see the empty data folder.
- says `demo: true` in `/api/ping`, with `demo/api/ping.json` laid over its own ping (a round under way, a summary).
- refuses every button (`POST`, but `/api/stop`) with 403: nothing changes.

An agent whose page process starts background work of its own (a watcher, a first scan) checks `isDemo()` (node/demo.ts) and leaves it off.

## The demo folder

- `demo/api/<path>.json`: one file per GET the page makes that should show something. Copy the shape from the real answer, and make up every value: names like "Holiday photos", "Invoices 2026", "family-recipes"; no real person's name or email, no path from a real PC (use `C:\Users\Alex\...`).
- `demo/hero.json` (optional): how Manor's capture takes the picture: `{ "path": "/#/findings", "wait": 1500 }`, the page's address (default `/`) and how long to let it settle after it loads, in milliseconds (default 1500).

Keep it small: the files ship with the agent's release, and the page should look as it does on a PC where the agent has been at work for a week.
