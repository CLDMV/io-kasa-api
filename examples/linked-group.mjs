#!/usr/bin/env node
/**
 * Linked group of devices — all-on / all-off ganging.
 *
 * Watches every device in the group for relay transitions. When any one of
 * them turns ON, the rest are turned ON. When any one of them turns OFF, the
 * rest are turned OFF. A physical press on any device in the group brings the
 * whole group along.
 *
 * Demonstrates:
 *   - api.monitor.watch — polled relay on/off transitions per device
 *   - api.bulk.switch.on(refs) / .off(refs) — mixed-ref bulk commands
 *     (switch.on / off work for plugs too — same set_relay_state protocol)
 *   - Per-device feedback-loop avoidance: when we propagate a change to a
 *     device, the *next* polled echo of that exact change is suppressed once
 *     — but a fresh user toggle right after is still picked up.
 *
 * Usage:
 *   node examples/linked-group.mjs <device1> <device2> [<device3> ...]
 *
 * Example:
 *   node examples/linked-group.mjs "Kitchen Pendant" Hallway "Living Room" Bedroom
 *
 * Note: the watchers poll on an interval (default 1s) — a physical press is
 * detected on the next poll, not instantly. Lower `intervalMs` for snappier
 * response at the cost of more network traffic.
 *
 * In your own code, import from the package name instead of the relative path:
 *   import { createKasaApi } from "@cldmv/io-kasa-api";
 */
import { createKasaApi } from "../src/index.mts";

const GROUP = process.argv.slice(2);
if (GROUP.length < 2) {
	console.error("Usage: node examples/linked-group.mjs <device1> <device2> [<device3> ...]");
	console.error('Example: node examples/linked-group.mjs Kitchen Hallway "Living Room" Bedroom');
	process.exit(1);
}

const POLL_MS = 1000; // how often each watcher polls its device's relay

const api = await createKasaApi();

api.events.on("error", (e) => console.warn(`[!] ${e.op}@${e.host ?? "?"}: ${e.error ?? "(no message)"}`));

console.log(`Linked group (${GROUP.length} devices):`);
for (const ref of GROUP) console.log(`  • ${ref}`);
console.log(`Any one ON → all ON. Any one OFF → all OFF. Polling every ${POLL_MS}ms.`);
console.log("Ctrl-C to stop.\n");

const ts = () => new Date().toLocaleTimeString();
const others = (sourceRef) => GROUP.filter((r) => r !== sourceRef);

/**
 * Per-device echo suppression. When we propagate `on` to device X, we record
 * "expect the next polled transition on X to be `on`" — that one event is
 * dropped without re-propagating, but a subsequent user toggle is honoured.
 * @type {Map<string, "on" | "off">}
 */
const expectEcho = new Map();

async function propagate(verb, sourceRef) {
	const refs = others(sourceRef);
	// Pre-mark each destination so its watcher's polled "on"/"off" echo of our
	// own bulk change is recognised and suppressed exactly once.
	for (const r of refs) expectEcho.set(r, verb);
	console.log(`[${ts()}] ${sourceRef} → ${verb.toUpperCase()} → ${refs.join(", ")}`);
	const results = await api.bulk.switch[verb](refs);
	// Bulk preserves input order — results[i] matches refs[i]. On a per-slot
	// failure clear the corresponding echo expectation (no echo will ever come).
	results.forEach((result, i) => {
		if (!result.ok) {
			console.warn(`[${ts()}]   ${refs[i]}: ${result.error}`);
			expectEcho.delete(refs[i]);
		}
	});
}

/** Watcher event handler — returns true if the event was a self-induced echo and should be ignored. */
function consumeEcho(ref, verb) {
	if (expectEcho.get(ref) === verb) {
		expectEcho.delete(ref);
		return true;
	}
	return false;
}

const watchers = GROUP.map((ref) => {
	const watcher = api.monitor.watch(ref, { intervalMs: POLL_MS });
	watcher.on("state", (e) => console.log(`[init] ${ref}: ${e.relayState === 1 ? "ON" : "OFF"}`));
	watcher.on("on", () => {
		if (consumeEcho(ref, "on")) return;
		propagate("on", ref);
	});
	watcher.on("off", () => {
		if (consumeEcho(ref, "off")) return;
		propagate("off", ref);
	});
	watcher.on("error", (err) => console.warn(`[${ts()}] ${ref} watcher: ${err?.message ?? err}`));
	return { ref, watcher };
});

process.on("SIGINT", () => {
	for (const { watcher } of watchers) watcher.stop();
	console.log("\nStopped.");
	process.exit(0);
});
