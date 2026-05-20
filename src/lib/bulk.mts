/**
 * Dynamic bulk layer.
 *
 * `buildBulk` walks the built API and mirrors every device-command module —
 * recursing the nested resource tree — so `api.bulk.motion.pir.sensitivity.set`
 * is generated from `api.motion.pir.sensitivity.set`. At each leaf the first
 * `ref` parameter becomes `refs[]` (a mixed array of {@link DeviceRef}s — IPs,
 * MACs, aliases, and/or `DeviceTarget` objects), the rest forward unchanged,
 * probes run with bounded concurrency, and the result is one `OpResult` per
 * slot — including `ok: false` slots for MAC/alias refs that didn't resolve.
 *
 * Bulk's per-slot resolution mirrors the single-device wrapper in
 * `src/lib/refs.mts`: object / IPv4 refs pass straight through (no cache,
 * no event); MAC / alias refs hit the cache (a fresh sweep first when the
 * trailing options or target carry `force: true`). Because every leaf already
 * emits its own three-tier event, a bulk call fires N events — correlate them
 * by `OpResult.target` / `OpEvent.target`.
 *
 * Imported by `index.mts` (the entry), not loaded by slothlet, so the relative
 * `./types.mts` import resolves normally.
 */
import { effectiveForce, refToTarget } from "./refs.mts";
import type { BulkApi, CommandOptions, DeviceRef, DeviceTarget, EventsApi, OpResult } from "./types.mts";
import type { DevicesApiInternal } from "./devices.mts";

/** Modules that take a `ref` first and so can be bulk-mirrored. */
const BULK_MODULES = ["device", "plug", "switch", "dimmer", "motion", "bulb", "energy", "schedule"] as const;

const DEFAULT_CONCURRENCY = 32;

/** Dependencies the bulk leaves need at call time (resolver + defaults snapshot). */
export type BulkDeps = {
	devices: DevicesApiInternal;
	events: EventsApi;
	/** Bus-level defaults snapshot — mutated by `events.configure`. */
	defaults: { force: boolean };
};

/** Run `worker` over `items` with at most `limit` in flight; preserves input order. */
async function pool<I, O>(items: ReadonlyArray<I>, limit: number, worker: (item: I, index: number) => Promise<O>): Promise<O[]> {
	const out: O[] = new Array(items.length);
	let cursor = 0;
	const lanes = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
		while (cursor < items.length) {
			const i = cursor++;
			out[i] = await worker(items[i] as I, i);
		}
	});
	await Promise.all(lanes);
	return out;
}

type Leaf = (target: DeviceTarget, ...rest: unknown[]) => Promise<OpResult>;
type Node = Record<string, unknown>;

/** Same shape as the trailing options peek in refs.mts — kept local to avoid a circular import. */
function peekOptions(args: ReadonlyArray<unknown>): CommandOptions | undefined {
	if (args.length === 0) return undefined;
	const last = args[args.length - 1];
	if (last === null || typeof last !== "object") return undefined;
	const keys = Object.keys(last);
	if (keys.length === 0) return {};
	const allowed = new Set(["confirm", "force"]);
	if (!keys.every((k) => allowed.has(k))) return undefined;
	return last as CommandOptions;
}

/** Build an `ok: false` OpResult for a slot whose MAC/alias ref didn't resolve. */
function unresolvedResult(op: string, ref: DeviceRef): OpResult {
	const refStr = typeof ref === "string" ? ref : (ref.host ?? "");
	return {
		ok: false,
		op,
		target: { host: refStr },
		host: refStr,
		error: `devices.resolve: no match for ${typeof ref === "string" ? JSON.stringify(ref) : `target ${refStr}`}`,
		reachable: false,
		durationMs: 0
	};
}

/** Recursively mirror a resource node: functions become bulk runners, objects recurse. */
function mirror(node: Node, deps: BulkDeps, concurrency: number, path: string): Node {
	const out: Node = {};
	for (const key of Object.keys(node)) {
		const value = node[key];
		const childPath = path ? `${path}.${key}` : key;
		if (typeof value === "function") {
			const fn = value as Leaf;
			out[key] = async (refs: ReadonlyArray<DeviceRef>, ...rest: unknown[]): Promise<OpResult[]> => {
				if (!Array.isArray(refs)) return [];
				const opts = peekOptions(rest);
				return pool(refs, concurrency, async (ref) => {
					const force = effectiveForce(ref, opts, deps.defaults);
					const target = await refToTarget(ref, deps.devices, force);
					if (target === null) return unresolvedResult(childPath, ref);
					return fn(target, ...rest);
				});
			};
		} else if (value && typeof value === "object") {
			out[key] = mirror(value as Node, deps, concurrency, childPath);
		}
	}
	return out;
}

/**
 * Build the `api.bulk.*` tree from the live API object.
 *
 * @param api - The slothlet-built API (must expose the device-command modules
 *              with their original `DeviceTarget`-only signatures; called
 *              before {@link attachRefResolution} mutates them).
 * @param deps - Resolver, event bus, and the bus-level defaults snapshot.
 * @param concurrency - Default in-flight probe count for every bulk call.
 */
export function buildBulk(
	api: Record<string, Node>,
	deps: BulkDeps,
	concurrency: number = DEFAULT_CONCURRENCY
): BulkApi {
	const bulk: Record<string, Node> = {};
	for (const moduleName of BULK_MODULES) {
		const mod = api[moduleName];
		if (mod) bulk[moduleName] = mirror(mod, deps, concurrency, moduleName);
	}
	return bulk as unknown as BulkApi;
}
