/**
 * Shared event bus + the central operation wrapper.
 *
 * Every device command runs through `run()`: it executes the work, captures
 * success or failure into an `OpResult` (it never throws), emits events, and
 * returns the result. This is the one place op events are produced — modules
 * don't wire events themselves.
 *
 * Events emitted on completion of every operation:
 *   - `"op"`      — every operation
 *   - `"<op>"`    — that operation's path, e.g. `"plug.on"`
 *   - `"success"` — successful operations
 *   - `"error"`   — failed operations
 *
 * Payload is an {@link OpEvent}. Subscribe via `api.events.on(...)`.
 */
import { EventEmitter } from "node:events";
import type { DeviceTarget, OpEvent, OpEventListener, OpResult } from "../../lib/types.mts";

/** The bus. Unbounded listeners — a monitoring app may attach many. */
const bus = new EventEmitter();
bus.setMaxListeners(0);
// Guard: emitting "error" with no listener attached would otherwise throw.
bus.on("error", () => {});

/** Error messages that indicate the device never answered (vs. a device-side error). */
const UNREACHABLE = /timeout|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ETIMEDOUT|closed before/i;

/** The underlying EventEmitter, for advanced use (raw `emit`, listener introspection). */
export const emitter = bus;

/** Subscribe to an operation event. */
export function on(event: string, listener: OpEventListener): void {
	bus.on(event, listener);
}

/** Subscribe to an operation event once. */
export function once(event: string, listener: OpEventListener): void {
	bus.once(event, listener);
}

/** Unsubscribe an operation-event listener. */
export function off(event: string, listener: OpEventListener): void {
	bus.off(event, listener);
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
	work: () => Promise<T> | T
): Promise<OpResult<T>> {
	const started = Date.now();
	const dot = op.indexOf(".");
	const module = dot < 0 ? op : op.slice(0, dot);
	const method = dot < 0 ? "" : op.slice(dot + 1);

	let result: OpResult<T>;
	try {
		const value = await work();
		result = {
			ok: true,
			op,
			target,
			host: target.host,
			value,
			reachable: true,
			durationMs: Date.now() - started
		};
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
	bus.emit("op", event);
	bus.emit(op, event);
	bus.emit(result.ok ? "success" : "error", event);
	return result;
}
