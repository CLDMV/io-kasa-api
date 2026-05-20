/**
 * Ref-resolution wrapper layer.
 *
 * The slothlet-loaded device-command modules accept `DeviceTarget`s only —
 * that's the contract `self.protocol.send` needs. To let callers pass any
 * {@link DeviceRef} (an IPv4 string, a MAC, an alias, or a target) and to
 * surface the `force` option (bypass the sweep cache for MAC/alias lookups),
 * `index.mts` walks every device-command module after slothlet builds and
 * replaces each leaf with a thin wrapper from this file.
 *
 * The wrapper:
 *   1. Peeks the trailing arg for {@link CommandOptions} (`{ confirm?, force? }`)
 *      to extract the effective `force` flag (per-call > target > global).
 *   2. Resolves the ref to a `DeviceTarget`:
 *        - sync passthrough for object / IPv4 refs (no event, no work)
 *        - cache lookup for MAC / alias refs (a fresh sweep first when forced)
 *   3. Calls the original leaf with the resolved target (and the original
 *      trailing args unchanged — `confirm` still flows through to `events.run`).
 *   4. Synthesizes an `ok: false` `OpResult` and emits one error event when a
 *      MAC/alias ref didn't resolve to any device, so a listener filtering on
 *      the command path (e.g. `"switch.on"`) still sees the failed slot.
 *
 * Imported by `index.mts` (the entry), not loaded by slothlet.
 */
import { EventEmitter } from "node:events";
import type {
	CommandOptions,
	DeviceMonitor,
	DeviceRef,
	DeviceTarget,
	EventsApi,
	OpResult
} from "./types.mts";
import { isIpv4 } from "./devices.mts";
import type { DevicesApiInternal } from "./devices.mts";

/** The single-device modules whose leaves take a ref as the first arg. */
export const REF_MODULES = ["device", "plug", "switch", "dimmer", "motion", "bulb", "energy", "schedule"] as const;

type Leaf = (...args: unknown[]) => unknown;
type Node = Record<string, unknown>;

type WrapDeps = {
	devices: DevicesApiInternal;
	events: EventsApi;
	/** Bus-level defaults snapshot — read at wrapper-build time (mutates on `configure`). */
	defaults: { force: boolean };
};

/**
 * Pluck the trailing {@link CommandOptions} (if any) off an args array. Does
 * not mutate `args`. Returns `undefined` when the last arg isn't a plain
 * options bag — distinguished by having only `confirm` / `force` keys, which
 * keeps us from misreading e.g. a `WatchOptions` object as command options.
 */
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

/** Pick the effective `force`: per-call options > target field > global default. */
export function effectiveForce(
	ref: DeviceRef,
	perCall: CommandOptions | undefined,
	defaults: { force: boolean }
): boolean {
	if (perCall && typeof perCall.force === "boolean") return perCall.force;
	if (typeof ref !== "string" && typeof ref.force === "boolean") return ref.force;
	return defaults.force;
}

/**
 * Async ref→target.
 *
 * For object / IPv4-string refs there's nothing to look up: we return without
 * ever consulting the resolver (so `force` is a documented no-op for these).
 * For MAC / alias refs we hit the fast-path cache (sync, no event); on a miss
 * — or when `force: true` — we fall through to `devices.resolve(ref, { force })`
 * which sweeps and emits a `devices.resolve` event. Returns `null` when a
 * MAC / alias couldn't be matched after the (forced) re-sweep.
 */
export async function refToTarget(
	ref: DeviceRef,
	devices: DevicesApiInternal,
	force: boolean
): Promise<DeviceTarget | null> {
	// Object ref: passthrough — no cache touch, no resolve call. `force` is moot.
	if (typeof ref !== "string") return ref;
	// IPv4 string: synthesised target — same passthrough rationale as the object case.
	if (isIpv4(ref)) return { host: ref };
	// MAC / alias: cache fast-path unless forced to re-sweep.
	if (!force) {
		const quick = devices.quickResolve(ref);
		if (quick) return quick;
	}
	return devices.resolve(ref, force ? { force: true } : undefined);
}

/** Build the `ok: false` OpResult emitted when a MAC/alias ref didn't resolve. */
function unresolvedResult(op: string, ref: DeviceRef, started: number): OpResult {
	const refStr = typeof ref === "string" ? ref : (ref.host ?? "");
	return {
		ok: false,
		op,
		target: { host: refStr },
		host: refStr,
		error: `devices.resolve: no match for ${typeof ref === "string" ? JSON.stringify(ref) : `target ${refStr}`}`,
		reachable: false,
		durationMs: Date.now() - started
	};
}

/** Wrap one leaf function with ref resolution. */
function wrapLeaf(fn: Leaf, op: string, deps: WrapDeps): Leaf {
	return async (...args: unknown[]) => {
		const started = Date.now();
		const ref = args[0] as DeviceRef;
		const opts = peekOptions(args.slice(1));
		const force = effectiveForce(ref, opts, deps.defaults);
		const target = await refToTarget(ref, deps.devices, force);
		if (target === null) {
			const result = unresolvedResult(op, ref, started);
			// Surface the same three-tier event a real failure would emit so a
			// listener filtering on `op` / `<op>` / leaf-action / `error` sees the
			// failed slot. `events.emitOp` runs inside the slothlet boundary and
			// has access to the real bus (the `api.events.emitter` field is
			// proxy-wrapped out here).
			deps.events.emitOp({
				...result,
				module: op.indexOf(".") < 0 ? op : op.slice(0, op.indexOf(".")),
				method: op.indexOf(".") < 0 ? "" : op.slice(op.indexOf(".") + 1),
				args: args.slice(1),
				at: Date.now()
			});
			return result;
		}
		// Replace ref with resolved target and forward.
		args[0] = target;
		return fn(...args);
	};
}

/** Recursively wrap every function leaf under `node`, prefixing op paths with `path`. */
function wrapNode(node: Node, path: string, deps: WrapDeps): void {
	for (const key of Object.keys(node)) {
		const value = node[key];
		const childPath = path ? `${path}.${key}` : key;
		if (typeof value === "function") {
			node[key] = wrapLeaf(value as Leaf, childPath, deps);
		} else if (value && typeof value === "object") {
			wrapNode(value as Node, childPath, deps);
		}
	}
}

/**
 * Attach the ref-resolution wrapper to every single-device module on `api`.
 * Mutates the modules in place — `api.plug.on`, `api.switch.on(...)`, etc.
 * now accept any {@link DeviceRef}. Bulk and signal have their own wrappers.
 */
export function attachRefResolution(
	api: Record<string, unknown>,
	deps: WrapDeps
): void {
	for (const moduleName of REF_MODULES) {
		const mod = api[moduleName];
		if (mod && typeof mod === "object") wrapNode(mod as Node, moduleName, deps);
	}
	// Monitor is handled separately — see `wrapMonitor`.
}

/**
 * Wrap `monitor.watch` / `monitor.watchMotion` so they accept any
 * {@link DeviceRef}. For object / IPv4 refs the wrapped call delegates
 * synchronously and returns the real watcher. For MAC / alias refs that need
 * the cache, we return a proxy `EventEmitter` immediately, kick off async
 * resolution, and either forward the real watcher's events once resolved or
 * emit `"error"` + `"stop"` on the next tick when the ref doesn't match.
 */
export function wrapMonitor(
	monitor: { watch: (target: DeviceTarget, options?: unknown) => DeviceMonitor; watchMotion: (target: DeviceTarget, options?: unknown) => DeviceMonitor },
	deps: WrapDeps
): void {
	const origWatch = monitor.watch.bind(monitor);
	const origWatchMotion = monitor.watchMotion.bind(monitor);

	function wrap(realFn: (target: DeviceTarget, options?: unknown) => DeviceMonitor) {
		return (ref: DeviceRef, options?: unknown): DeviceMonitor => {
			// Fast-path: no async resolution needed.
			const quick = deps.devices.quickResolve(ref);
			const force = effectiveForce(ref, undefined, deps.defaults);
			if (quick && !force) return realFn(quick, options);

			// Async resolution path — return a proxy emitter.
			const proxy = new EventEmitter() as DeviceMonitor;
			let real: DeviceMonitor | null = null;
			let stopped = false;
			(proxy as unknown as { stop: () => void }).stop = () => {
				stopped = true;
				if (real) real.stop();
				else proxy.emit("stop");
			};
			refToTarget(ref, deps.devices, force)
				.then((target) => {
					if (stopped) return;
					if (!target) {
						proxy.emit("error", new Error(`devices.resolve: no match for ${typeof ref === "string" ? JSON.stringify(ref) : ref.host}`));
						proxy.emit("stop");
						return;
					}
					real = realFn(target, options);
					for (const ev of ["state", "on", "off", "change", "motion", "clear", "error", "stop"] as const) {
						real.on(ev, (payload: unknown) => proxy.emit(ev, payload));
					}
				})
				.catch((err: unknown) => {
					proxy.emit("error", err instanceof Error ? err : new Error(String(err)));
					proxy.emit("stop");
				});
			return proxy;
		};
	}

	monitor.watch = wrap(origWatch);
	monitor.watchMotion = wrap(origWatchMotion);
}
