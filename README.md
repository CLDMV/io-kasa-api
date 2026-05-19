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

```js
import { createKasaApi } from "@cldmv/io-kasa-api";

const api = await createKasaApi({ sweepCidr: "10.0.0.0/24" });

// Watch failures across every operation.
api.events.on("error", (e) => console.warn(`${e.op} @ ${e.host}: ${e.error}`));

// Resolve a device by name (or MAC, or IP) — the sweep is cached.
const lamp = await api.devices.resolve("Living Room Lamp");

// Commands never throw — check `ok`.
const r = await api.switch.on(lamp);
if (!r.ok) console.warn(`turn-on failed: ${r.error}`);

await api.dimmer.brightness.set(lamp, 60);
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
| `reachable` | `false` when the failure was a connectivity error |
| `durationMs` | wall-clock duration |

### Events

A shared bus fires on every operation: `op` (all), `<op-path>` (e.g.
`"plug.on"`), `success`, and `error`. Each payload is the `OpResult` plus
dispatch detail. Subscribe via `api.events.on(event, listener)`.

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
| `mode` | `"eager"` | `"eager"` loads all modules up front; `"lazy"` defers |
| `bulkConcurrency` | `32` | in-flight probe count for `api.bulk.*` |
| `context` | `{}` | extra context propagated through slothlet |
| `debug` | `false` | slothlet debug logging |

## Bulk operations

Every device command has a `bulk` twin that takes an array of targets:

```js
const results = await api.bulk.plug.on([{ host: "10.0.0.5" }, { host: "10.0.0.6" }]);
// → one OpResult per device, in input order, non-responders included
```

## Monitoring

```js
// Relay on/off transitions.
const w = api.monitor.watch(lamp);
w.on("on", (e) => console.log("on"));
w.on("off", (e) => console.log("off"));

// Debounced PIR motion — one `motion` event per burst, `clear` after a quiet window.
const m = api.monitor.watchMotion(sensor, { clearMs: 5000 });
m.on("motion", (e) => console.log(`motion @ ${e.percent.toFixed(0)}%`));
m.on("clear", (e) => console.log(`still after ${e.durationMs}ms`));
m.stop();
```

## Signal report

```js
const report = await api.signal.report({ cidr: "10.0.0.0/24" });
// [{ host, alias, model, rssi, quality, reachable }, ...] sorted strongest→weakest
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
