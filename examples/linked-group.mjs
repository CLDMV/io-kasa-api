#!/usr/bin/env node
/**
 * Linked group of devices — all-on / all-off ganging.
 *
 * Ties N devices together: a transition on any one of them propagates to the
 * rest. A physical press on any device in the group brings the whole group
 * along.
 *
 * Built on `api.link(refs, opts)` — one line of setup. The helper handles:
 *   - one `api.monitor.watch` per device (relay polling on `pollMs` cadence)
 *   - per-event self-vs-external attribution via `MonitorEvent.cause` (so the
 *     polled echo of our own bulk command is dropped without any time-window
 *     race against a legitimate user toggle moments later)
 *   - bulk propagation via `api.bulk.switch.on/off(others)`
 *   - clean shutdown via `group.stop()`
 *
 * For comparison, doing this by hand (the previous version of this example)
 * was ~50 lines plus the per-device `expectEcho` Map for feedback suppression.
 *
 * Usage:
 *   node examples/linked-group.mjs [<device1> <device2> [<device3> ...]]
 *
 *   With no arguments, defaults to the staircase lights:
 *     "Staircase Top", "Staircase Bottom"
 *
 * Example:
 *   node examples/linked-group.mjs "Kitchen Pendant" Hallway "Living Room" Bedroom
 *
 * Note: the watchers poll on an interval (default 1s) — a physical press is
 * detected on the next poll, not instantly. Lower `pollMs` for snappier
 * response at the cost of more network traffic.
 *
 * In your own code, import from the package name instead of the relative path:
 *   import { createKasaApi } from "@cldmv/io-kasa-api";
 */
import { createKasaApi } from "../src/index.mts";

const DEFAULT_GROUP = ["Staircase Top", "Staircase Bottom"];
const GROUP = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_GROUP;
if (GROUP.length < 2) {
	console.error("Usage: node examples/linked-group.mjs [<device1> <device2> [<device3> ...]]");
	console.error(`  Default group: ${DEFAULT_GROUP.map((r) => `"${r}"`).join(", ")}`);
	process.exit(1);
}

const api = await createKasaApi();

api.events.on("error", (e) => console.warn(`[!] ${e.op}@${e.host ?? "?"}: ${e.error ?? "(no message)"}`));

console.log(`Linked group (${GROUP.length} devices):`);
for (const ref of GROUP) console.log(`  • ${ref}`);
console.log("Any one ON → all ON. Any one OFF → all OFF. Ctrl-C to stop.\n");

const ts = () => new Date().toLocaleTimeString();

const group = api.link(GROUP, { pollMs: 1000 });

group.on("propagate", (e) => {
	console.log(`[${ts()}] ${e.source} → ${e.verb.toUpperCase()} → ${e.targets.join(", ")}`);
	for (const r of e.results) {
		if (!r.ok) console.warn(`[${ts()}]   ${r.host}: ${r.error}`);
	}
});
group.on("error", (err) => console.warn(`[${ts()}] watcher: ${err.message}`));

process.on("SIGINT", () => {
	group.stop();
	console.log("\nStopped.");
	process.exit(0);
});
