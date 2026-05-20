#!/usr/bin/env node
/**
 * Motion-triggered light.
 *
 * Watches a motion sensor (KS200M / KS220M / ES20M dimmer) for PIR motion;
 * when motion is detected, switches a second device on. After a configurable
 * stillness window with no motion, switches it back off.
 *
 * Demonstrates:
 *   - api.monitor.watchMotion — debounced `motion` / `clear` events
 *   - api.switch.on(ref) / .off(ref) — accepts any DeviceRef (IP / MAC / alias)
 *     and works for both plugs and wall switches (same set_relay_state command)
 *   - api.events.on("error") — central error sink so no failure is silent
 *
 * Usage:
 *   node examples/motion-trigger.mjs [<sensor>] [<light>] [<offAfterMs>]
 *
 *   <sensor>       MAC / alias / IP of the motion device (default: "Hallway Motion")
 *   <light>        MAC / alias / IP of the device to switch (default: "Pantry Light")
 *   <offAfterMs>   Stillness window before the light turns off (default: 30000)
 *
 * Example:
 *   node examples/motion-trigger.mjs "Hallway Motion" "Pantry Light" 60000
 *
 * In your own code, import from the package name instead of the relative path:
 *   import { createKasaApi } from "@cldmv/io-kasa-api";
 */
import { createKasaApi } from "../src/index.mts";

const SENSOR = process.argv[2] ?? "Hallway Motion";
const LIGHT = process.argv[3] ?? "Pantry Light";
const OFF_AFTER_MS = Number(process.argv[4] ?? 30000);

const api = await createKasaApi();

// Central error sink — every failed op (motion poll, switch call, …) lands here.
api.events.on("error", (e) => console.warn(`[!] ${e.op}: ${e.error ?? "(no message)"}`));

console.log(`Sensor:  ${SENSOR}`);
console.log(`Light:   ${LIGHT}`);
console.log(`Off after ${OFF_AFTER_MS}ms of stillness. Walk in front of the sensor.`);
console.log("Ctrl-C to stop.\n");

const ts = () => new Date().toLocaleTimeString();

let lightOn = false;
/** @type {NodeJS.Timeout | null} */
let offTimer = null;

const watcher = api.monitor.watchMotion(SENSOR, { clearMs: 1500 });

watcher.on("motion", async () => {
	if (offTimer) {
		clearTimeout(offTimer);
		offTimer = null;
	}
	if (lightOn) return;
	console.log(`[${ts()}] ★ motion → ${LIGHT} ON`);
	const r = await api.switch.on(LIGHT);
	lightOn = r.ok;
	if (!r.ok) console.warn(`[${ts()}]   failed: ${r.error}`);
});

watcher.on("clear", () => {
	if (offTimer) clearTimeout(offTimer);
	offTimer = setTimeout(async () => {
		offTimer = null;
		if (!lightOn) return;
		console.log(`[${ts()}]   still for ${OFF_AFTER_MS}ms → ${LIGHT} OFF`);
		const r = await api.switch.off(LIGHT);
		if (r.ok) lightOn = false;
		else console.warn(`[${ts()}]   failed: ${r.error}`);
	}, OFF_AFTER_MS);
});

watcher.on("error", (err) => console.warn(`[${ts()}] watcher: ${err?.message ?? err}`));

process.on("SIGINT", () => {
	if (offTimer) clearTimeout(offTimer);
	watcher.stop();
	console.log("\nStopped.");
	process.exit(0);
});
