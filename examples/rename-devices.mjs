#!/usr/bin/env node
/**
 * One-shot device renaming from a JSON map of desired aliases.
 *
 * Reads a JSON file keyed by IP or MAC, finds each device on the network,
 * and renames any whose alias has drifted from the desired value. Devices
 * not in the map are left alone; keys with no matching device are reported
 * as "missing" instead of failing the whole apply.
 *
 * Demonstrates:
 *   - api.aliases.apply(source, opts) — one-shot rename
 *   - desired-state JSON format (IP / MAC keys, alias values)
 *   - the ApplyReport return shape: per-key outcomes + summary counts
 *
 * Usage:
 *   node examples/rename-devices.mjs [<path-to-json>]
 *
 *   Default path: ./examples/aliases.example.json (which is intentionally
 *   stuffed with placeholders — edit it first, or pass your own file).
 *
 * In your own code, import from the package name instead of the relative path:
 *   import { createKasaApi } from "@cldmv/io-kasa-api";
 */
import { resolve } from "node:path";
import { createKasaApi } from "../src/index.mts";

const sourcePath = resolve(process.argv[2] ?? "examples/aliases.example.json");

const api = await createKasaApi();
api.events.on("error", (e) => console.warn(`[!] ${e.op}@${e.host ?? "?"}: ${e.error ?? "(no message)"}`));

console.log(`Reading desired aliases from: ${sourcePath}`);
console.log(`Sweeping the network — this can take a few seconds...\n`);

const report = await api.aliases.apply(sourcePath, { confirm: true });

const symbol = {
	renamed: "✓",
	unchanged: "·",
	missing: "?",
	failed: "✗"
};

for (const o of report.outcomes) {
	const tag = symbol[o.action];
	const where = o.host ? `(${o.host})` : "";
	const detail =
		o.action === "renamed"
			? `"${o.current ?? ""}" → "${o.desired}"`
			: o.action === "unchanged"
				? `"${o.desired}" (no change)`
				: o.action === "missing"
					? `no device matches this key`
					: `${o.desired} — failed: ${o.error}`;
	console.log(`  ${tag} ${o.key.padEnd(20)} ${where.padEnd(14)} ${detail}`);
}

console.log(
	`\nrenamed:${report.counts.renamed} · unchanged:${report.counts.unchanged} · missing:${report.counts.missing} · failed:${report.counts.failed}`
);

await api.slothlet?.shutdown?.();
