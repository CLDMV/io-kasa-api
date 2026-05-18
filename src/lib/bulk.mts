/**
 * Dynamic bulk layer.
 *
 * Rather than hand-writing a bulk variant of every command, `buildBulk` walks
 * the built API and mirrors each device-command module: `api.bulk.plug.on` is
 * generated from `api.plug.on`. The first `target` parameter becomes a
 * `targets[]`, the rest forward unchanged, probes run with bounded concurrency,
 * and the result is one `OpResult` per device.
 *
 * Because every single command already emits its own event, a bulk call fires
 * N events — correlate them by `OpResult.target` / `OpEvent.target`.
 *
 * This file is imported by `index.mts` (the entry), not loaded by slothlet, so
 * the relative `./types.mts` import resolves normally.
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

type AnyApi = Record<string, Record<string, unknown>>;

/**
 * Build the `api.bulk.*` tree from the live API object.
 *
 * @param api - The slothlet-built API (must expose the device-command modules).
 * @param concurrency - Default in-flight probe count for every bulk call.
 */
export function buildBulk(api: AnyApi, concurrency: number = DEFAULT_CONCURRENCY): BulkApi {
	const bulk: Record<string, Record<string, unknown>> = {};

	for (const moduleName of BULK_MODULES) {
		const mod = api[moduleName];
		if (!mod) continue;
		const bulkMod: Record<string, unknown> = {};

		for (const methodName of Object.keys(mod)) {
			const fn = mod[methodName];
			if (typeof fn !== "function") continue;

			bulkMod[methodName] = (targets: DeviceTarget[], ...rest: unknown[]): Promise<OpResult[]> => {
				if (!Array.isArray(targets)) {
					throw new TypeError(
						`api.bulk.${moduleName}.${methodName}: first argument must be a DeviceTarget[]`
					);
				}
				return pool(targets, concurrency, (t) => (fn as (...a: unknown[]) => Promise<OpResult>)(t, ...rest));
			};
		}
		bulk[moduleName] = bulkMod;
	}

	return bulk as unknown as BulkApi;
}
