#!/usr/bin/env node
/**
 * Continuous alias drift correction.
 *
 * Watches a desired-state JSON file on an interval. On every tick the file
 * is re-read (so you can edit it live), the network is checked, and any
 * device whose alias has drifted from the desired value is renamed back.
 * Useful for keeping a fleet's names canonical — if someone uses the Kasa
 * app to rename a device, this pulls it back.
 *
 * Demonstrates:
 *   - api.aliases.watch(source, opts) — interval monitor
 *   - hot-reload of the source file (no restart needed)
 *   - the watcher's event surface (tick / renamed / missing / error / stop)
 *
 * Usage:
 *   node examples/watch-aliases.mjs [<path-to-json>] [<intervalMs>]
 *
 *   Default path: ./examples/aliases.example.json
 *   Default interval: 30000 ms (30 s)
 *
 * In your own code, import from the package name instead of the relative path:
 *   import { createKasaApi } from "@cldmv/io-kasa-api";
 */
import { resolve } from "node:path";
import { createKasaApi } from "../src/index.mts";

const sourcePath = resolve(process.argv[2] ?? "examples/aliases.example.json");
const intervalMs = Number(process.argv[3] ?? 30000);

const api = await createKasaApi();
api.events.on("error", (e) => console.warn(`[!] ${e.op}@${e.host ?? "?"}: ${e.error ?? "(no message)"}`));

console.log(`Watching ${sourcePath} every ${intervalMs}ms.`);
console.log("Edit the file at any time — the next tick picks up your changes.");
console.log("Ctrl-C to stop.\n");

const ts = () => new Date().toLocaleTimeString();

const watcher = api.aliases.watch(sourcePath, { intervalMs, confirm: true });

watcher.on("renamed", (o) => {
	console.log(`[${ts()}] ✓ renamed ${o.key} (${o.host}): "${o.current}" → "${o.desired}"`);
});
watcher.on("missing", (keys) => {
	console.log(`[${ts()}] ? missing: ${keys.join(", ")}`);
});
watcher.on("tick", (report) => {
	if (report.counts.renamed === 0 && report.counts.failed === 0 && report.counts.missing === 0) {
		// Quiet tick — everything matches.
		process.stdout.write(`\r[${ts()}] ok — ${report.counts.unchanged} aliases consistent`);
	} else {
		console.log(
			`[${ts()}] tick — renamed:${report.counts.renamed} unchanged:${report.counts.unchanged} ` +
				`missing:${report.counts.missing} failed:${report.counts.failed}`
		);
	}
});
watcher.on("error", (err) => console.warn(`[${ts()}] error: ${err.message}`));

process.on("SIGINT", () => {
	watcher.stop();
	console.log("\nStopped.");
	process.exit(0);
});
