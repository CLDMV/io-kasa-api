# @cldmv/io-kasa-api

Local-network control for TP-Link **Kasa** smart devices — plugs, switches,
dimmers, bulbs, power strips, and motion sensors — over the legacy port-9999
protocol. No cloud account, no internet round-trip.

Built on [`@cldmv/slothlet`](https://github.com/CLDMV/slothlet): the API is a
nested resource tree assembled at runtime from the modules under `src/api/`.

## Features

- **Nested resource API** — `api.dimmer.brightness.set(...)`,
  `api.motion.pir.triggered.get(...)` — reads like a REST tree.
- **Never throws** — every command resolves to an `OpResult`
  (`{ ok, value, error, ... }`). Failures are values and events, not exceptions.
- **Event bus** — every operation emits `op` / `<path>` / `success` / `error`
  events, each carrying the device target.
- **Discovery** — UDP broadcast (`discover`) and cross-subnet unicast CIDR
  `sweep`.
- **Device resolver + cache** — address a device by MAC, alias, or IP; the
  underlying sweep is cached so a long-running app doesn't re-scan per command.
- **Bulk layer** — every command mirrored to operate on a list of devices with
  bounded concurrency; non-responders come back as `ok: false`.
- **Monitoring** — poll-based watchers for relay on/off and debounced PIR motion.
- **Signal report** — RSSI across the network, sorted best→worst.

## Requirements

- **Node.js ≥ 20.19**
- Devices reachable on the LAN that speak the legacy TP-Link **port-9999**
  protocol — most `HS`, `KP`, `KL`, `KS`, and `ES` Kasa models. Newer
  **KLAP-only** (port 20002) and **Matter-only** (Matter commissioning via
  port 80 "SHIP 2.0") devices are out of scope — see [Troubleshooting](#troubleshooting--devices-that-dont-show-up) for diagnosis.

## Install

```sh
npm install @cldmv/io-kasa-api
```

## Quick start

The event bus is the **primary** interface: register handlers once, then
fire commands and forget — outcomes arrive as events. Awaiting a command for
its `OpResult` is fully supported too; it just isn't the main path.

```js
import { createKasaApi } from "@cldmv/io-kasa-api";

const api = await createKasaApi({ sweepCidr: "10.0.0.0/24" });

// 1. Register handlers once.
api.events.on("op", (e) => console.log(`${e.op} @ ${e.host} → ${e.ok ? "ok" : e.error}`));
api.events.on("error", (e) => console.warn(`${e.op} failed @ ${e.host}: ${e.error}`));

// 2. Fire and forget — no await; the outcome lands on the bus.
// Every command accepts a DeviceRef — an IP, MAC, alias, or target object.
api.switch.on("Living Room Lamp");                       // alias → cached sweep lookup
api.dimmer.brightness.set("10.0.0.5", 60);               // IP → blind fire, no cache touch
api.bulk.plug.on(["Pantry Light", "10.0.0.6", "Lamp"]);  // mixed-ref bulk
```

```js
// --- Alternative: await a command for its OpResult inline ---
const r = await api.switch.off(lamp);
if (!r.ok) console.warn(`turn-off failed: ${r.error}`);
```

## Concepts

### `OpResult` — the no-throw contract

Every device command resolves to an `OpResult`; it never rejects.

| Field | Meaning |
|---|---|
| `ok` | did the operation succeed |
| `op` | operation path, e.g. `"dimmer.brightness.set"` |
| `target` / `host` | the device the op addressed |
| `value` | parsed device response, when `ok` |
| `error` | message, when `!ok` |
| `reachable` | `false` when the failure was a connectivity error or an unresolved MAC/alias ref |
| `durationMs` | wall-clock duration |

### Targeting — `DeviceRef`

Every command on `api.<module>.…` (and every slot in a `api.bulk.*` array)
accepts a **`DeviceRef`** — one of these interchangeable forms:

| Form | Example | Cache touched? | Notes |
|---|---|---|---|
| `DeviceTarget` object | `{ host: "10.0.0.5", port: 9999 }` | no — fire blind | The most explicit form. Pin `port`, `timeoutMs`, per-target `confirm` / `force` / `child` here. |
| IPv4 string | `"10.0.0.5"` | no — fire blind | Synthesised to `{ host: ref }`. Uses defaults (port 9999, default timeout). |
| MAC string | `"aa:bb:cc:dd:ee:ff"` | yes — sweep cache | Any separator (`:`, `-`, none) and any case. Looked up in the resolver's cache; sweeps once on a miss. |
| Device alias string | `"Living Room Lamp"` | yes — sweep cache | Matched against `sysInfo.alias`, case- and whitespace-insensitive. |
| **Child of a strip** — `host/<index>` | `"10.0.0.5/0"` | yes — sweep cache | Outlet 0 of the strip at 10.0.0.5. Resolves to `{ host, child: <id> }`. |
| **Child of a strip** — `host/<childId>` | `"10.0.0.5/8006…F00"` | yes — sweep cache | Same, addressing the outlet by its full hex child ID. |
| **Child alias string** | `"Cario Cabinet"` | yes — sweep cache | Walks every device's `sysInfo.children[].alias`; resolves to the parent + that child. Duplicates: first match wins, a `devices.resolve` warning event fires. |

```js
// All four forms work everywhere:
api.switch.on({ host: "10.0.0.5", timeoutMs: 2000 });
api.switch.on("10.0.0.5");
api.switch.on("aa:bb:cc:dd:ee:ff");
api.switch.on("Living Room Lamp");

// Mixed in bulk:
api.bulk.plug.on([
  "10.0.0.5",
  "aa:bb:cc:dd:ee:ff",
  "Pantry Light",
  { host: "10.0.0.6", port: 9999 }
]);

// signal.report takes the same shapes (plus CIDR):
api.signal.report();                  // local broadcast
api.signal.report("10.0.0.0/24");     // sweep that CIDR
api.signal.report("10.0.0.5");        // single-device report
api.signal.report({ devices: [...] }) // full control
```

**Unresolved MAC/alias** (the resolver can't find a match, even after a
re-sweep) resolves to an `OpResult` with `ok: false`, `reachable: false`, and
an `error` describing the miss — same shape as any other failed op. A
listener on `"switch.on"` (or `error`, or `op`) sees the failure too.

### Verified writes — `confirm` · Cache bypass — `force`

Two flags travel on the same precedence chain — **per-call > target > global**:

| Flag | Default | When `true` |
|---|---|---|
| `confirm` | `false` | After a mutating write returns `err_code: 0`, the API re-reads the value and resolves `ok: false` if it doesn't match. Paranoia mode for writes. |
| `force` | `false` | For MAC/alias refs only: the resolver throws away the cache and re-sweeps before the lookup. Useful when DHCP renewed the IP under the same MAC/name. **No-op for `DeviceTarget` and IPv4 refs** — there's nothing to bypass. |

Settable from three places:

```js
// 1. Global — every command on this API uses these defaults.
const api = await createKasaApi({ confirm: true, force: true });

// 2. Per-target — applies to every command for this target object.
api.switch.on({ host: "10.0.0.5", confirm: true, force: true });

// 3. Per-call — overrides target / global, either direction.
api.switch.on("Lamp", { force: true });               // re-sweep first
api.switch.on(target, { confirm: false });            // skip the read-back
api.switch.on({ host, confirm: true }, { confirm: false }); // per-call wins
```

A few commands have no sensible `confirm` read-back (`device.reboot` — the
device is gone) — they accept the option but ignore it and fall back to
trusting `err_code: 0`.

### Events — the primary interface

Every device command runs through one wrapper that, on completion, emits on
the shared `api.events` bus **and** resolves an `OpResult`. The intended
style is fire-and-forget — register handlers once, then issue commands
without `await`. A command **never rejects** (the no-throw contract), so an
un-awaited call raises no unhandled rejection. An operation's event fires
when the operation **completes** — for a write, when the device returns
`err_code: 0`, its own acknowledgement that the change was applied. The API
issues no separate read-back; the send-then-verify loop in `tools/devtest.mts`
is test-harness rigor, not API behaviour.

Each operation emits across **three tiers** — listen as broadly or as
narrowly as you want:

| Tier | Event | Fires for |
|---|---|---|
| **general** | `op` | every operation |
| | `success` | every operation that succeeded |
| | `error` | every operation that failed |
| **path** | `"<module>.….<method>"` | one exact operation — `"plug.on"`, `"dimmer.brightness.set"` |
| **specific** | `"<method>"` (leaf) | that action on any module — `"on"` fires for `plug.on`, `switch.on`, `bulb.on` |

```js
api.events.on("op", (e) => {});       // general  — everything
api.events.on("error", (e) => {});    // general  — every failure
api.events.on("plug.on", (e) => {});  // path     — only plug.on
api.events.on("on", (e) => {});       // specific — anything turning on
api.events.on("set", (e) => {});      // specific — any setter

api.plug.on(target);           // no await — outcome lands on the bus
api.bulk.switch.off(targets);  // ditto
```

Each payload is an `OpEvent` — an `OpResult` plus `module`, `method`,
`args`, and `at`.

**Globs.** `on` / `once` / `off` also accept a `*` glob, matched against the
operation's path:

```js
api.events.on("plug.*", (e) => {});        // every plug operation
api.events.on("*.set", (e) => {});         // every setter, any module
api.events.on("motion.pir.*", (e) => {});  // every PIR operation
api.events.off("plug.*", handler);         // remove it with the same glob
```

### Event reference

**General** (3): `op` · `success` · `error`.

**Specific** (the leaf action — fires for that action on *any* module, e.g.
`on` → `plug.on` + `switch.on` + `bulb.on`):
`get` · `set` · `on` · `off` · `toggle` · `reboot` · `clear` · `erase`.

**Path** — one event per method, named by its full dotted path:

| Module | Path events (`<module>.…`) |
|---|---|
| `device` | `info.get` · `alias.get` · `alias.set` · `led.get` · `led.set` · `reboot` |
| `plug` | `power.get` · `on` · `off` · `toggle` · `children.set` |
| `switch` | `power.get` · `on` · `off` · `toggle` |
| `dimmer` | `brightness.get` · `brightness.set` · `parameters.get` · `doubleClick.set` · `longPress.set` |
| `motion` | `pir.get` · `pir.set` · `pir.sensitivity.get` · `pir.sensitivity.set` · `pir.cooldown.get` · `pir.cooldown.set` · `pir.adc.get` · `pir.status.get` · `pir.triggered.get` · `ambient.get` · `ambient.enabled.get` · `ambient.enabled.set` · `ambient.darkThreshold.get` · `ambient.darkThreshold.set` |
| `bulb` | `state.get` · `state.set` · `power.get` · `on` · `off` · `brightness.get` · `brightness.set` · `color.get` · `color.set` · `colorTemp.get` · `colorTemp.set` |
| `energy` | `realtime.get` · `stats.daily.get` · `stats.monthly.get` · `stats.erase` |
| `schedule` | `rules.get` · `rules.clear` |

So `api.dimmer.brightness.set(...)` emits `dimmer.brightness.set` (path),
`set` (specific), `op`, and `success` (or `error`). `*.power.set` routes to
`on`/`off`, so it emits `*.on` / `*.off` — there is no `power.set` event.

> The `monitor` watchers are a **separate** event source — see
> [Monitoring](#monitoring). Their events are *not* on the `api.events` bus.

### Discovery & the device resolver

- `api.discovery.discover()` — UDP broadcast; **local subnet only** (broadcasts
  don't cross routers).
- `api.discovery.sweep(cidr)` — unicast TCP probe of every host in a CIDR;
  **works across subnets/VLANs**.
- `api.devices.resolve(ref)` — `ref` is an IP, MAC, alias, or `DeviceTarget`.
  An IP resolves directly; a MAC/name is looked up in the cached sweep. The
  first call sweeps once; later calls hit the cache. On a miss it re-sweeps
  once (covers a newly-added device or a dropped probe).
- `api.devices.list()` / `api.devices.refresh()` — cached list / force re-scan.

`createKasaApi({ sweepCidr })` sets the CIDR the resolver scans — defaults to
the `KASA_SWEEP` env var, then `10.8.0.0/23`.

These methods are no-throw too: they emit on the `api.events` bus and resolve
to a natural value (or `[]` / `null` / `undefined` on failure). `discover` /
`sweep` give `[]` on a bad CIDR / interface failure; `resolve` gives `null`
on a miss; `resolveBroadcast` gives `null` when no usable interface exists.
The emitted `OpEvent` has no `target` / `host` (those fields are optional for
non-device operations).

## API overview

`createKasaApi(options?)` returns:

```
api
├── device     info · alias · led · reboot()
├── plug       power · on() · off() · toggle() · children
├── switch     power · on() · off() · toggle()
├── dimmer     brightness · parameters · fade · gentle · doubleClick · longPress
├── motion     pir{ get,set,sensitivity,cooldown,adc,status,triggered } · ambient
├── bulb       state · power · on() · off() · brightness · color · colorTemp
├── energy     realtime · stats{ daily,monthly,erase }
├── schedule   rules{ get,clear }
├── discovery  discover() · sweep() · resolveBroadcast()
├── monitor    watch() · watchMotion()
├── protocol   send() · sendUdp() · encrypt*/decrypt*
├── events     on/once/off · emitter · run()
├── devices    resolve() · find() · list() · refresh()
├── bulk       every device module above, but over a refs[] array
├── signal     report()
├── link()     gang N devices — any one transition propagates to the rest
└── aliases    apply() · watch() — desired-state device naming
```

Resource leaves expose `get` / `set`, e.g. `api.dimmer.brightness.set(target, 60)`
or `api.device.alias.get(target)`.

### `createKasaApi` options

| Option | Default | Purpose |
|---|---|---|
| `sweepCidr` | `KASA_SWEEP` env / `10.8.0.0/23` | CIDR the device resolver sweeps |
| `confirm` | `false` | global default for verified writes — see [Targeting](#targeting--deviceref) |
| `force` | `false` | global default for bypassing the resolver sweep cache on MAC/alias refs — see [Targeting](#targeting--deviceref) |
| `mode` | `"eager"` | `"eager"` loads all modules up front; `"lazy"` defers |
| `bulkConcurrency` | `32` | in-flight probe count for `api.bulk.*` |
| `context` | `{}` | extra context propagated through slothlet |
| `debug` | `false` | slothlet debug logging |

## Bulk operations

Every device command has a `bulk` twin that takes an array of refs — mix any
shape of `DeviceRef` in a single call:

```js
const results = await api.bulk.plug.on([
  "10.0.0.5",                  // IP string → blind fire
  "aa:bb:cc:dd:ee:ff",         // MAC → cache lookup
  "Pantry Light",              // alias → cache lookup
  "10.8.1.50/0",               // strip child by index → cache lookup
  "Cario Cabinet",             // strip child by alias → cache lookup
  { host: "10.0.0.6", port: 9999 }  // object target
]);
// → one OpResult per slot, in input order. Non-responders come back ok:false
//   reachable:false; MAC/alias misses come back ok:false with an error.
// Each slot also emits its own event under the command's path (`plug.on`).
```

### Multi-outlet plugs (HS300 / KP200) — relay control

A multi-outlet strip has children — each outlet is its own logical device. Three ways to address one for `on` / `off` / `toggle` / `power`:

```js
// 1. Ref form — most ergonomic; the resolver populates target.child for you.
await api.plug.on("10.8.1.50/0");      // outlet 0 of the strip at 10.8.1.50
await api.plug.on("Cario Cabinet");    // outlet matched by its alias

// 2. Object target with `child` — when you already know the IDs.
await api.plug.on({ host: "10.8.1.50", child: "8006…F00" });

// 3. Explicit `api.plug.children.set` — bulk multiple outlets in one call.
await api.plug.children.set({ host: "10.8.1.50" }, ["8006…F00", "8006…F01"], true);
```

**What about a "naked" strip target?** `api.plug.on({ host: "10.8.1.50" })` with no `child` does a pre-read of `get_sysinfo` to detect children: if it's a strip, the call **broadcasts to every outlet** in one command (and verify checks every outlet's state). If it's a single-outlet plug, the call is the same bare `set_relay_state` it's always been. `toggle` follows the same broadcast rule — `any-on → all-off`, otherwise `all-on → all-off`.

`api.switch.*` mirrors this for symmetry (multi-outlet wall switches aren't shipping today, but the contract stays consistent).

## Monitoring

`monitor.watch()` and `monitor.watchMotion()` each return their **own**
`EventEmitter` — distinct from the `api.events` operation bus. Where
`api.events` reports *operations you issued*, a watcher reports *observed
device state*: it polls, so it catches a change from **any** cause — a
physical press, another app, motion — not just your own commands.

| Watcher | Events |
|---|---|
| `watch()` | `state` (initial reading) · `on` · `off` · `change` · `error` · `stop` |
| `watchMotion()` | `motion` · `clear` · `error` · `stop` |
| `watch({ motion: true })` | all of the above combined |

```js
// Relay on/off transitions — emits state / on / off / change.
const w = api.monitor.watch(lamp);
w.on("on", (e) => console.log("on"));
w.on("off", (e) => console.log("off"));

// Debounced PIR motion — emits motion / clear (one `motion` per burst).
const m = api.monitor.watchMotion(sensor, { clearMs: 5000 });
m.on("motion", (e) => console.log(`motion @ ${e.percent.toFixed(0)}%`));
m.on("clear", (e) => console.log(`still after ${e.durationMs}ms of motion`));

m.stop(); // watchers also emit `error` (a failed poll) and `stop`
```

#### `MonitorEvent.cause` — self-vs-external attribution

Every relay transition event (`on` / `off` / `change`) carries a `cause` field:

| Value | Meaning |
|---|---|
| `"self"` | A successful `on` / `off` / `toggle` command for this host with the matching verb landed via this API instance within the last ~3× the poll interval. The transition is almost certainly the echo of your own command. |
| `"external"` | No recent self-command matches. A physical press, another app, or scheduling caused it. |
| `"unknown"` | Baseline `"state"` events (we don't know what put the relay in this state when we started watching). |

Use it to silence echoes of your own commands without writing time-window
hacks. The classic case is ganging — see [`api.link()`](#linking-with-apilink).

```js
const w = api.monitor.watch("Lamp");
w.on("on", (e) => {
  if (e.cause === "self") return;     // ignore my own commands
  console.log("Someone else turned it on!");
});
```

Caveat: only correlates with commands issued through the same `KasaApi`
instance. A second process flipping the relay reads as `"external"`.

### Linking with `api.link()`

`api.link(refs, opts?)` gangs N devices: a transition on any one of them
propagates to the rest. Built on `api.monitor.watch` + `api.bulk.switch`,
using `MonitorEvent.cause === "self"` to drop the polled echo of its own
bulk command — so a fresh user toggle right after a propagation is still
handled correctly (no time-window race).

```js
const group = api.link(["Kitchen", "Hallway", "Living Room", "Bedroom"], {
  pollMs: 1000,    // per-device poll cadence
  onAny: "all-on", // default — any device on → all on
  offAny: "all-off" // default — any device off → all off
});

group.on("propagate", (e) => {
  console.log(`${e.source} → ${e.verb} → ${e.targets.join(", ")}`);
});
group.on("error", (err) => console.warn(err.message));

// Later:
group.stop(); // halts every watcher; emits "stop"
```

A worked example is in [`examples/linked-group.mjs`](./examples/linked-group.mjs).
A motion-trigger example using `api.monitor.watchMotion` + `api.switch.on`
is in [`examples/motion-trigger.mjs`](./examples/motion-trigger.mjs).

### Desired-state aliases with `api.aliases`

`api.aliases` keeps device names canonical from a map you control. The map is
keyed by IPv4 or MAC; values are the alias each device should carry. Source
can be a JSON file path, an object, or a function — all three forms are
re-evaluated on every call (and every tick, in watch mode) so you can edit
the file or have your function return fresh data and the watcher picks it
up without restarting.

```js
// One-shot rename — read once, fix drift, report what happened.
const report = await api.aliases.apply("/path/to/aliases.json", { confirm: true });
console.log(report.counts);   // { renamed, unchanged, missing, failed }
for (const o of report.outcomes) {
  if (o.action === "renamed") console.log(`${o.host}: "${o.current}" → "${o.desired}"`);
}

// Continuous monitor — re-check every 30 s; pull any drift back to canonical.
const watcher = api.aliases.watch("/path/to/aliases.json", { intervalMs: 30000 });
watcher.on("renamed", (o) => console.log(`fixed ${o.key}: ${o.current} → ${o.desired}`));
watcher.on("missing", (keys) => console.log(`no devices for: ${keys.join(", ")}`));
process.on("SIGINT", () => watcher.stop());

// Live-updating function source — return whatever the source of truth is now.
const w = api.aliases.watch(async () => fetchAliasesFromCmdb(), { intervalMs: 60000 });
```

Source format:

```json
{
  "10.8.1.35": "Staircase Light",
  "aa:bb:cc:dd:ee:ff": "Living Room Lamp",
  "AABBCCDDEEFF": "Kitchen Pendant — MAC keys are case- and separator-insensitive",
  "10.8.1.50/0": "Outlet 0 of a multi-outlet strip (HS300 / KP200)",
  "10.8.1.50/1": "Outlet 1 of the same strip",
  "aa:bb:cc:dd:ee:ff/0": "MAC + child also works"
}
```

#### Multi-outlet plugs (HS300 / KP200)

A multi-outlet strip has children — each outlet carries its own alias and is what users actually reference, not the parent's auto-generated `TP-LINK_Smart Plug_57A5`. Address an outlet with `<host>/<index>`:

- `10.8.1.50/0` — outlet 0 (the parent's `sysInfo.children[0]`)
- `10.8.1.50/1` — outlet 1
- `aa:bb:cc:dd:ee:ff/0` — same, by parent MAC
- `10.8.1.50/8006DBCE…F00` — exact match by full child ID (case-insensitive hex)

Under the hood the rename wraps the protocol command in `context: { child_ids: [<id>] }`. The parent's alias is unaffected. `--min` from the discover tool prints exactly this key form so you can copy rows straight into the JSON map:

```sh
npm run discover -- --sweep 10.8.0.0/23 --min
# Name                    IP            Model      MAC
# Cario Cabinet           10.8.1.50/1   KP200(US)  6C:5A:B0:06:57:A5
# Plug 1                  10.8.1.50/0   KP200(US)  6C:5A:B0:06:57:A5
```

For one-off child renames outside this helper, the low-level call is:

```js
await api.device.alias.set(target, "Top Outlet", { child: "<child id>", confirm: true });
```

Worked examples in [`examples/rename-devices.mjs`](./examples/rename-devices.mjs)
(one-shot) and [`examples/watch-aliases.mjs`](./examples/watch-aliases.mjs)
(interval). Starter mapping in [`examples/aliases.example.json`](./examples/aliases.example.json).

## Signal report

```js
await api.signal.report();                  // UDP broadcast on the local subnet
await api.signal.report("10.0.0.0/24");     // sweep that CIDR
await api.signal.report("10.0.0.5");        // single-device report (IP / MAC / alias)
await api.signal.report({ cidr: "10.0.0.0/24", concurrency: 16, timeoutMs: 2000 });
await api.signal.report({ devices: ["Living Room Lamp", "10.0.0.6"] });

// → [{ host, alias, model, rssi, quality, reachable }, ...] sorted strongest→weakest
```

## CLI tools

Scripts under `tools/` run with Node's native type stripping and accept a
**MAC, name, or IP**:

```sh
node --experimental-strip-types tools/list-devices.mts            # device names
node --experimental-strip-types tools/power.mts "Lamp" off        # on / off / toggle
node --experimental-strip-types tools/devtest.mts "Lamp"          # on/off + dimming exercise
node --experimental-strip-types tools/motionwatch.mts "Hallway"   # live motion watcher
node --experimental-strip-types tools/dumpall.mts "Lamp"          # every namespace a device exposes
npm run discover                                                  # raw discovery dump
```

## Examples

Runnable scenarios under [`examples/`](./examples/):

- [`motion-trigger.mjs`](./examples/motion-trigger.mjs) — watch a motion sensor; switch another device on when motion fires, off after a stillness window.
- [`linked-group.mjs`](./examples/linked-group.mjs) — gang N devices: any one going on/off propagates to the rest, with per-device echo suppression so feedback loops don't form.
- [`rename-devices.mjs`](./examples/rename-devices.mjs) — one-shot rename pass from a JSON map of desired aliases (keyed by IP or MAC).
- [`watch-aliases.mjs`](./examples/watch-aliases.mjs) — continuous drift correction: re-reads the JSON each tick, renames any device that's been changed back to canonical.

See [`examples/README.md`](./examples/README.md) for usage and the patterns they lean on.

## Troubleshooting — devices that don't show up

A device the Kasa app shows but `npm run discover` doesn't usually means one of:

1. **The "Third Party Compatibility" toggle is off.** Most common cause on newer Matter-enabled SKUs (ES20M dimmers, some KP/KS variants). In the Kasa app, find **Third Party Compatibility** and flip it ON. As of this writing it lives in the app's **global Settings** (Me / hamburger menu → Settings), not per-device — but TP-Link has been known to move things around, so if it isn't there, check the per-device settings page as well. This single toggle gates the legacy XOR listener on port 9999 across every device on your account — with it off the affected devices are *Matter-only* on the LAN even though they can speak both. Flip it on and they immediately start answering `--sweep`.
2. **Newer firmware that dropped the legacy LAN protocol entirely.** TP-Link has migrated several SKU lines onto **KLAP** (port 20002) or **Matter only** (Matter commissioning advertised over HTTP on port 80, `Server: SHIP 2.0`). Neither is implemented here — but check the toggle in (1) first; many devices that *look* Matter-only just have the legacy listener gated.
3. **Cloud-only LAN.** Some devices keep no useful local listener — they reach TP-Link's cloud, and the Kasa app talks to them via cloud. They'll appear in the app regardless of any LAN protocol.
4. **Network reachability.** Firewall, VLAN, mDNS reflection, or a multi-NIC host that's binding broadcasts to the wrong interface. `--sweep <cidr>` (unicast TCP) bypasses broadcast issues; if that still doesn't find it, the next checks apply.

Diagnose a specific IP with the built-in probe:

```sh
npm run discover -- --probe 10.8.1.119
```

It probes TCP 9999 (legacy XOR), UDP 9999 (legacy discovery), TCP 20002 (KLAP), TCP 50443 (Tapo TLS), and HTTP 80/443 (HTTP-GETting `/` to capture the `Server:` header). The classification line at the bottom tells you which bucket the device falls in:

```
Port    Service                    Status    Server    Hint
------  -------------------------  --------  --------  ----
9999    Kasa legacy (XOR)          ★ OPEN              ✓ this driver speaks this
20002   KLAP (newer HS / KP)       refused             ✗ not implemented here
50443   Tapo TLS                   refused             ✗ not implemented here
443     HTTPS                      refused             informational
80      HTTP                       ★ OPEN    SHIP 2.0  informational
9999    Kasa legacy (UDP unicast)  ★ OPEN              ✓ device answered get_sysinfo over UDP

→ Legacy Kasa LAN protocol present — this driver can talk to it via api.* ✓
  (also exposes Matter commissioning on port 80 — Server: "SHIP 2.0".
  That's additive, not exclusive; controlling via legacy works fine.)
```

`Server: SHIP 2.0` on port 80 means the device exposes the Matter Commissioning Protocol — it can be paired into a Matter fabric. **It does not preclude legacy LAN control** when "Third Party Compatibility" is on. If you see SHIP 2.0 *and* `9999 refused`, flip the toggle in the Kasa app first — the setting lives under the app's **global Settings** (Me / hamburger menu → Settings), but if it isn't there in your version, check the per-device settings page too.

If the legacy port really is gone (toggle on and 9999 still refused), the device is Matter-only on the LAN. To control it use a Matter controller (Home Assistant's matter-server, Apple Home, Google Home, Alexa). Matter support could be added here (the spec is open; `matter.js` exists), but it's a different protocol stack — commissioning flow, NOC storage, CASE/PASE crypto — and a much larger build than the legacy XOR driver. It hasn't been done yet.

## Development

```sh
npm test          # vitest suite
npm run typecheck # tsc, no emit
```

## License

[Apache-2.0](./LICENSE)
