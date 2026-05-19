/**
 * Dynamic bulk layer.
 *
 * `buildBulk` walks the built API and mirrors every device-command module —
 * recursing the nested resource tree — so `api.bulk.motion.pir.sensitivity.set`
 * is generated from `api.motion.pir.sensitivity.set`. At each leaf the first
 * `target` parameter becomes a `targets[]`, the rest forward unchanged, probes
 * run with bounded concurrency, and the result is one `OpResult` per device.
 *
 * Because every single command already emits its own event, a bulk call fires
 * N events — correlate them by `OpResult.target` / `OpEvent.target`.
 *
 * Imported by `index.mts` (the entry), not loaded by slothlet, so the relative
 * `./types.mts` import resolves normally.
 */
import type { BulkApi, DeviceTarget, OpResult } from "./types.mts";

/** Modules that take a `target` first and so can be bulk-mirrored. */
const BULK_MODULES = ["device", "plug", "switch", "dimmer", "motion", "bulb", "energy", "schedule"] as const;

const DEFAULT_CONCURRENCY = 32;

/** Run `worker` over `items` with at most `limit` in flight; preserves input order. */
async function pool<I, O>(items: I[], limit: number, worker: (item: I) => Promise<O>): Promise<O[]> {
	const out: O[] = new Array(items.length);
	let cursor = 0;
	const lanes = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
		while (cursor < items.length) {
			const i = cursor++;
			out[i] = await worker(items[i] as I);
		}
	});
	await Promise.all(lanes);
	return out;
}

type Leaf = (target: DeviceTarget, ...rest: unknown[]) => Promise<OpResult>;
type Node = Record<string, unknown>;

/** Recursively mirror a resource node: functions become bulk runners, objects recurse. */
function mirror(node: Node, concurrency: number, path: string): Node {
	const out: Node = {};
	for (const key of Object.keys(node)) {
		const value = node[key];
		const childPath = `${path}.${key}`;
		if (typeof value === "function") {
			const fn = value as Leaf;
			out[key] = (targets: DeviceTarget[], ...rest: unknown[]): Promise<OpResult[]> => {
				// No-throw: a non-array first arg resolves to an empty batch
				// (childPath is captured for any future event hook).
				void childPath;
				if (!Array.isArray(targets)) return Promise.resolve([]);
				return pool(targets, concurrency, (t) => fn(t, ...rest));
			};
		} else if (value && typeof value === "object") {
			out[key] = mirror(value as Node, concurrency, childPath);
		}
	}
	return out;
}

/**
 * Build the `api.bulk.*` tree from the live API object.
 *
 * @param api - The slothlet-built API (must expose the device-command modules).
 * @param concurrency - Default in-flight probe count for every bulk call.
 */
export function buildBulk(api: Record<string, Node>, concurrency: number = DEFAULT_CONCURRENCY): BulkApi {
	const bulk: Record<string, Node> = {};
	for (const moduleName of BULK_MODULES) {
		const mod = api[moduleName];
		if (mod) bulk[moduleName] = mirror(mod, concurrency, moduleName);
	}
	return bulk as unknown as BulkApi;
}
