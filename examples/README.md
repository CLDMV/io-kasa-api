# Examples

Runnable end-to-end examples showing how to drive the API from real-world scenarios. Each script is self-contained, accepts CLI arguments for the devices it touches, and uses the same patterns you'd write in your own code.

| Script | What it does |
|---|---|
| [`motion-trigger.mjs`](./motion-trigger.mjs) | Watch a motion sensor; turn another device on when motion fires, off after a stillness window. |
| [`linked-group.mjs`](./linked-group.mjs) | Link N devices together — any one going on or off propagates to the rest. Uses `api.link()`, the built-in helper, so the runnable logic is ~10 lines. |

## Running

Examples import from the local source (`../src/index.mts`), so they run straight from the repo:

```sh
# Motion sensor in the hallway, light in the pantry, 60 s off-window.
node examples/motion-trigger.mjs "Hallway Motion" "Pantry Light" 60000

# Four devices ganged together — toggling any one toggles all four.
node examples/linked-group.mjs "Kitchen Pendant" Hallway "Living Room" Bedroom
```

In your own project (after `npm install @cldmv/io-kasa-api`), swap the import:

```js
// in-repo (this folder)
import { createKasaApi } from "../src/index.mts";
// in your project
import { createKasaApi } from "@cldmv/io-kasa-api";
```

## Patterns these examples lean on

- **Device refs.** `api.switch.on("Pantry Light")` and `api.bulk.switch.on(["Kitchen", "10.0.0.5"])` — every command takes a MAC, alias, IP string, or `DeviceTarget` object interchangeably. See [Targeting](../README.md#targeting--deviceref).
- **Event bus for failures.** A single `api.events.on("error", …)` handler catches every failed op — motion polls, switch calls, anything — so we never silently miss a problem.
- **`switch.*` for plugs too.** Plugs and wall switches speak the same `system.set_relay_state` command, so `api.switch.on(plug)` works fine. Use `api.plug.*` only when you need plug-specific features (children, etc.).
- **`api.link()` for ganging.** When you'd otherwise write watch + bulk + echo-suppression by hand, prefer the built-in helper. It uses [`MonitorEvent.cause`](../README.md#monitor--api-events--monitorevent-cause) under the hood, which solves the feedback-loop problem precisely (per device, per direction, one-shot) without a time-window race.
- **Polling caveat.** `api.monitor.watch` polls the relay on an interval. A physical press is caught on the *next* poll, not the moment it happens — lower `intervalMs` for snappier response at the cost of more network traffic. (TP-Link's legacy protocol has no push notifications.)
