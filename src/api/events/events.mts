/**
 * Shared event bus + the central operation wrapper.
 *
 * Every device command runs through `run()`: it executes the work, captures
 * success or failure into an `OpResult` (it never throws), emits events, and
 * returns the result. This is the one place op events are produced — modules
 * don't wire events themselves.
 *
 * Every operation emits across three tiers, so a listener can be as broad
 * or as narrow as it wants:
 *   - general  — `"op"` (every operation), `"success"`, `"error"`
 *   - path     — the full op path, e.g. `"plug.on"`, `"dimmer.brightness.set"`
 *   - specific — the leaf action, e.g. `"on"` (fires for plug.on, switch.on,
 *                bulb.on, …), `"set"`, `"get"`, `"toggle"`
 *
 * Payload is an {@link OpEvent}. Subscribe via `api.events.on(...)`.
 */
import { EventEmitter } from "node:events";
import type { DeviceTarget, Failure, OpEvent, OpEventListener, OpResult } from "../../lib/types.mts";

/** The bus. Unbounded listeners — a monitoring app may attach many. */
const bus = new EventEmitter();
bus.setMaxListeners(0);
// Guard: emitting "error" with no listener attached would otherwise throw.
bus.on("error", () => {});

/** Error messages that indicate the device never answered (vs. a device-side error). */
const UNREACHABLE = /timeout|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ETIMEDOUT|closed before/i;

/** The underlying EventEmitter, for advanced use (raw `emit`, listener introspection). */
export const emitter = bus;

/**
 * Bus-level defaults — global toggles overridden per-target and per-call.
 *
 *   - `confirm` — read-back verification for mutating writes.
 *   - `force`   — bypass the resolver sweep cache for MAC/alias refs.
 *
 * `force` is consumed by the ref-resolution wrapper (`src/lib/refs.mts`) and
 * by `bulk.mts`; `run()` itself doesn't read it. We keep both on one object
 * so a single `events.configure({ ... })` call wires everything, and so the
 * wrapper can hold a live reference to the snapshot (mutations land here).
 */
export const defaults = { confirm: false, force: false };

/** Set bus-level defaults. Called by `createKasaApi` to wire the globals. */
export function configure(options: { confirm?: boolean; force?: boolean }): void {
	if (typeof options.confirm === "boolean") defaults.confirm = options.confirm;
	if (typeof options.force === "boolean") defaults.force = options.force;
}

/**
 * Return the live bus-level defaults object. The same object is returned every
 * call — the ref-resolution / bulk wrappers in `src/lib/` capture this
 * reference once and observe mutations from later `configure()` calls.
 */
export function getDefaults(): { confirm: boolean; force: boolean } {
	return defaults;
}

/**
 * Low-level: emit a pre-built {@link OpEvent} across all three tiers (general
 * `op` / `success` | `error`, path `<op>`, leaf action) on the **real** bus.
 *
 * Used by the ref-resolution wrapper in `src/lib/refs.mts` to surface the
 * synthetic `ok: false` event for a MAC/alias ref that didn't resolve.
 * `api.events.emitter` isn't suitable for this from outside the slothlet
 * boundary — the field is proxy-wrapped — so we route through here instead.
 */
export function emitOp<T>(event: OpEvent<T>): void {
	const op = event.op;
	const action = op.slice(op.lastIndexOf(".") + 1);
	bus.emit("op", event);
	bus.emit(op, event);
	if (action && action !== op) bus.emit(action, event);
	const channel = event.ok ? "success" : "error";
	if (channel !== "error" || bus.listenerCount("error") > 0) bus.emit(channel, event);
}

/**
 * Build a `Failure` sentinel — `return self.events.failure("...")` from inside
 * a `work` callback to signal failure without throwing. `run` / `runUntargeted`
 * convert it into the same `ok: false` + `error` event as a caught throw.
 */
export function failure(message: string): Failure {
	return { __failure: message };
}

/** Type guard for {@link Failure}. */
export function isFailure(value: unknown): value is Failure {
	return value !== null && typeof value === "object" && "__failure" in value;
}

// --- Glob subscriptions -------------------------------------------------------
// An event name containing `*` is a glob, matched against each operation's
// `op` path. Glob listeners hang off the `"op"` catch-all and filter by regex;
// the registry maps a caller's listener back to its wrapped op-listener so
// `off()` can find and remove it.

/** Translate a glob (`*` is the only wildcard) to a regex anchored over the op path. */
function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/** Per-listener glob subscriptions, keyed by the caller's original listener. */
const globSubs = new Map<OpEventListener, Set<{ event: string; wrapped: OpEventListener }>>();

/**
 * Subscribe to an operation event.
 *
 * `event` may be a literal name — a tier (`"op"` / `"success"` / `"error"`),
 * a full path (`"plug.on"`), or a leaf action (`"on"`) — or a **glob** with
 * `*` matched against the op path, e.g. `"plug.*"`, `"*.set"`, `"motion.*"`.
 */
export function on(event: string, listener: OpEventListener): void {
	if (!event.includes("*")) {
		bus.on(event, listener);
		return;
	}
	const re = globToRegex(event);
	const wrapped: OpEventListener = (ev) => {
		if (re.test(ev.op)) listener(ev);
	};
	let subs = globSubs.get(listener);
	if (!subs) {
		subs = new Set();
		globSubs.set(listener, subs);
	}
	subs.add({ event, wrapped });
	bus.on("op", wrapped);
}

/** Subscribe to an operation event once. `event` may be a glob (see {@link on}). */
export function once(event: string, listener: OpEventListener): void {
	if (!event.includes("*")) {
		bus.once(event, listener);
		return;
	}
	const wrap: OpEventListener = (ev) => {
		off(event, wrap);
		listener(ev);
	};
	on(event, wrap);
}

/** Unsubscribe a listener — pass the same `event` (literal or glob) it was added with. */
export function off(event: string, listener: OpEventListener): void {
	if (!event.includes("*")) {
		bus.off(event, listener);
		return;
	}
	const subs = globSubs.get(listener);
	if (!subs) return;
	for (const sub of subs) {
		if (sub.event !== event) continue;
		bus.off("op", sub.wrapped);
		subs.delete(sub);
	}
	if (subs.size === 0) globSubs.delete(listener);
}

/**
 * Run a unit of work as a tracked operation.
 *
 * Executes `work`; on success the resolved value becomes `OpResult.value`,
 * on any throw the message becomes `OpResult.error`. Either way it resolves
 * (never rejects) and emits `op` / `<op>` / `success` | `error`.
 *
 * @param op - Operation path, e.g. `"plug.on"`.
 * @param target - Device the operation targets (rides along on the result/event).
 * @param args - Arguments beyond the target, surfaced on the event for correlation.
 * @param work - The actual device work. May throw / reject — it's caught.
 */
export async function run<T>(
	op: string,
	target: DeviceTarget,
	args: unknown[],
	work: () => Promise<T | Failure> | T | Failure,
	opts?: { verify?: (() => Promise<boolean>) | undefined; confirm?: boolean | undefined }
): Promise<OpResult<T>> {
	const started = Date.now();
	const dot = op.indexOf(".");
	const module = dot < 0 ? op : op.slice(0, dot);
	const method = dot < 0 ? "" : op.slice(dot + 1);
	// Per-call options > target field > global default.
	const effectiveConfirm = opts?.confirm ?? target.confirm ?? defaults.confirm;

	let result: OpResult<T>;
	try {
		const value = await work();
		if (isFailure(value)) {
			// work() signalled failure via the no-throw sentinel.
			result = {
				ok: false,
				op,
				target,
				host: target.host,
				error: value.__failure,
				reachable: true,
				durationMs: Date.now() - started
			};
		} else if (effectiveConfirm && opts?.verify) {
			// Verified write: after the device acked, read the value back and compare.
			let verified = false;
			try {
				verified = await opts.verify();
			} catch {
				// A verify failure (e.g. unreadable device) collapses to "not confirmed".
				verified = false;
			}
			if (!verified) {
				result = {
					ok: false,
					op,
					target,
					host: target.host,
					error: "unconfirmed: device state did not match the requested value after the write",
					reachable: true,
					durationMs: Date.now() - started
				};
			} else {
				result = { ok: true, op, target, host: target.host, value: value as T, reachable: true, durationMs: Date.now() - started };
			}
		} else {
			result = { ok: true, op, target, host: target.host, value: value as T, reachable: true, durationMs: Date.now() - started };
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		result = {
			ok: false,
			op,
			target,
			host: target.host,
			error: message,
			reachable: !UNREACHABLE.test(message),
			durationMs: Date.now() - started
		};
	}

	const event: OpEvent<T> = { ...result, module, method, args, at: Date.now() };
	// Three tiers: general (op / success / error), path (the full op string),
	// and specific (the leaf action — e.g. "on" fires for plug.on, switch.on).
	const action = op.slice(op.lastIndexOf(".") + 1);
	bus.emit("op", event);
	bus.emit(op, event);
	if (action && action !== op) bus.emit(action, event);
	// Node's EventEmitter throws when `error` is emitted with no listeners — a
	// `listenerCount` check makes this unconditionally safe regardless of any
	// transient gap in the listener guard.
	const channel = result.ok ? "success" : "error";
	if (channel !== "error" || bus.listenerCount("error") > 0) bus.emit(channel, event);
	return result;
}

/**
 * Run a unit of work that is **not** addressed to a device — i.e. discovery
 * and devices-cache operations. Same event-emitting / no-throw contract as
 * {@link run}, but the emitted {@link OpEvent} has no `target`/`host` and the
 * function resolves to the raw value (or `fallback` on failure) rather than
 * an `OpResult`.
 */
export async function runUntargeted<T>(
	op: string,
	args: unknown[],
	work: () => Promise<T | Failure> | T | Failure,
	fallback: T
): Promise<T> {
	const started = Date.now();
	const dot = op.indexOf(".");
	const module = dot < 0 ? op : op.slice(0, dot);
	const method = dot < 0 ? "" : op.slice(dot + 1);
	const action = op.slice(op.lastIndexOf(".") + 1);

	let event: OpEvent<T>;
	let returnValue: T;
	try {
		const value = await work();
		if (isFailure(value)) {
			returnValue = fallback;
			event = {
				ok: false,
				op,
				error: value.__failure,
				reachable: true,
				args,
				module,
				method,
				durationMs: Date.now() - started,
				at: Date.now()
			};
		} else {
			returnValue = value as T;
			event = { ok: true, op, value: value as T, args, module, method, durationMs: Date.now() - started, at: Date.now() };
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		returnValue = fallback;
		event = {
			ok: false,
			op,
			error: message,
			reachable: !UNREACHABLE.test(message),
			args,
			module,
			method,
			durationMs: Date.now() - started,
			at: Date.now()
		};
	}

	bus.emit("op", event);
	bus.emit(op, event);
	if (action && action !== op) bus.emit(action, event);
	const channel = event.ok ? "success" : "error";
	if (channel !== "error" || bus.listenerCount("error") > 0) bus.emit(channel, event);
	return returnValue;
}
