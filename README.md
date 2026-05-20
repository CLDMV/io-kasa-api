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
  **KLAP-only** devices (port 20002) are out of scope.

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
accepts a **`DeviceRef`** — one of four interchangeable forms:

| Form | Example | Cache touched? | Notes |
|---|---|---|---|
| `DeviceTarget` object | `{ host: "10.0.0.5", port: 9999 }` | no — fire blind | The most explicit form. Pin `port`, `timeoutMs`, per-target `confirm` / `force` here. |
| IPv4 string | `"10.0.0.5"` | no — fire blind | Synthesised to `{ host: ref }`. Uses defaults (port 9999, default timeout). |
| MAC string | `"aa:bb:cc:dd:ee:ff"` | yes — sweep cache | Any separator (`:`, `-`, none) and any case. Looked up in the resolver's cache; sweeps once on a miss. |
| Alias (name) string | `"Living Room Lamp"` | yes — sweep cache | Matched against `sysInfo.alias`, case- and whitespace-insensitive. |

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
├── bulk       every device module above, but over a targets[] array
└── signal     report()
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
  { host: "10.0.0.6", port: 9999 }  // object target
]);
// → one OpResult per slot, in input order. Non-responders come back ok:false
//   reachable:false; MAC/alias misses come back ok:false with an error.
// Each slot also emits its own event under the command's path (`plug.on`).
```

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

## Development

```sh
npm test          # vitest suite
npm run typecheck # tsc, no emit
```

## License

[Apache-2.0](./LICENSE)
