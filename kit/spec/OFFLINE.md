# Offline: waited out, never an alarm

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/OFFLINE.md` in [Jcollier0120/Steward](https://github.com/Jcollier0120/Steward). Since kit 2.15.0.

A PC that is offline knows it: Windows says so in the taskbar, and the person sees it. So nothing in the manor tells them again. A round, an update look, a feed or a release that fails only because the network isn't there is **waited out**: it isn't a failure, an alarm, a notification or a red badge, and it is tried again at its usual time. Once the PC is back online, everything goes on as before, and what still fails then is reported as ever, its hours counted from then.

## Whether this PC is online: `node/net.ts`

- **`online()`**: a look at the network. A TCP connection to port 443 of a few well-known hosts (`PROBE_HOSTS`: github.com, Windows' own www.msftconnecttest.com, www.cloudflare.com), by name, all at once, each given 3 s. Any one answering is online; none is offline, as is a PC that can't resolve a name. The answer is kept for a minute online and 20 s offline, so coming back is seen soon; two asking at once share one look. It never throws.
- **`offlineSince()`**: when this process first saw the PC offline, in this spell; null online.
- **`isNetworkError(e)`**: whether a failure looks like the network's, from its code (or its `cause`'s: `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `ECONNRESET`, `ENETUNREACH`, `EHOSTUNREACH`, undici's connect timeout, ...) or its words (Node's `getaddrinfo`, git's `Could not resolve host`, gh's `error connecting to`, Go's `dial tcp` and `no such host`, `fetch failed`, `socket hang up`). `ECONNREFUSED` is never one: a local server refuses, and a model server that is down is no network.
- **`offlineFailure(e)`**: the question every caller asks. True for an `Offline` thrown on purpose, or for a network failure while `online()` says offline. A network failure while online is a real one (GitHub down, a host gone), and is reported as ever.
- **`Offline`**: an error to throw when an agent knows already that its work waits for the network.
- **`MANOR_OFFLINE`**: `1` says offline without looking (a drill, a test), `0` online.

## What waits

- **A kit agent's round** (`schedule.ts`'s `every()`): a round that throws an offline failure ended waiting for the network. Its `lastRunOk` is null and `lastRunOffline` true (`/api/ping` gives both), round.json says `"ok": null, "offline": true` (ROUND.md), and its log line says it waits, never "run failed". So the Surveyor finds no failed round, and Manor's card says nothing failed.
- **An agent's own network work** inside a round (a feed, a mailbox): an agent that catches its errors per feed asks `offlineFailure(e)` and shows that feed as waiting for the network, not failed.
- **The Steward**: a round while offline asks GitHub nothing (it would fail for every employee, every few minutes). The alarms leave out what is only the network's while offline: Manor's update look and an update it couldn't download, and any condition whose words are a network failure. A release, a self release or a kit rollout that fails offline, or with a network failure's words, is never held against its commit: the next round tries it again.
- **Manor**: its hourly update look while offline keeps what it knew and says it waits for the network, not that its checks fail; an automatic update that can't download offline isn't counted against its tries.
