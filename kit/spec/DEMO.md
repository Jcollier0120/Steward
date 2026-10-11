# Demo mode: an agent's page with made-up data

Manor shows a picture of each employee's page in its entry (the hire popup, and the role's own page) instead of the office's initial. Those pictures ship to everyone, so they must never show anyone's own files, mail, repositories or folders: they are taken in demo mode, from made-up data. Manor keeps each agent's in its own tools/heroes/<id>/ and takes the pictures with tools/heroes.ts (`KIT_DEMO=<that folder>`), so an agent's repository needn't carry any; an agent may keep its own `demo` folder too (`KIT_DEMO=1`).

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

- lays the demo folder's file for a GET over the agent's own answer, key by key at the top: `/api/page` with `demo/api/page.json` holding `{ "body": … }` keeps the frame the kit builds (title, themes, tour) and shows the made-up body. A GET with no handler of its own is the file alone. The query is ignored.
- answers the rest with the agent's own handlers, which see the empty data folder.
- shows the page everyone sees: developer content is off, whatever the PC's own Developer options say, unless the demo's `hero.json` says `"developer": true` (a developer agent, whose pictures only developers see): then it's on.
- runs no rounds (schedule.ts), so nothing of the PC taking the picture is read, and holds nothing for required settings (required.ts): the page as it is once set up. The developer view's footer names `C:\Users\Alex\.<id>` as its data folder.
- says `demo: true` in `/api/ping`, with `demo/api/ping.json` laid over its own ping (a round under way, a summary).
- refuses every button (`POST`, but `/api/stop`) with 403: nothing changes.

An agent whose page process starts background work of its own (a watcher, a first scan) checks `isDemo()` (node/demo.ts) and leaves it off.

## The demo folder

- `demo/api/<path>.json`: one file per GET the page makes that should show something. Copy the shape from the real answer, and make up every value: names like "Holiday photos", "Invoices 2026", "family-recipes"; no real person's name or email, no path from a real PC (use `C:\Users\Alex\...`).
- A time as `"@now"`, `"@now-300"` (five minutes before) or `"@now+3600"` is filled in when it's read, so the page says "5 min ago" whenever the picture is taken.
- `demo/hero.json` (optional): how Manor's capture takes the picture: `{ "path": "/#/findings", "wait": 1500 }`, the page's address (default `/`) and how long to let it settle after it loads, in milliseconds (default 1500). An agent whose page isn't served by `node src\cli.ts serve` adds `"command": ["<its command>", ...]`. `"developer": true` shows the developer view (above).

Keep it small, and make the page look as it does on a PC where the agent has been at work for a week.
