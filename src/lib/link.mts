/**
 * Device-linking helper — gang N devices so a transition on any one of them
 * propagates to the rest. One line replaces the watch + bulk + echo-suppression
 * boilerplate that the [examples/linked-group](../../examples/linked-group.mjs)
 * pattern hand-rolls.
 *
 * Built on:
 *   - `api.monitor.watch(ref, { intervalMs })` — one watcher per device.
 *   - `api.bulk.switch[verb](refs)` — propagation as one bulk call.
 *   - `MonitorEvent.cause === "self"` — drops the polled echo of our own
 *     bulk command without a time-window race. (The cause field is set by
 *     `src/api/monitor/monitor.mts` from a `success`-bus subscription.)
 *
 * Imported by `index.mts`; not loaded by slothlet.
 */
import { EventEmitter } from "node:events";
import type {
	BulkApi,
	DeviceMonitor,
	DeviceRef,
	LinkApi,
	LinkOptions,
	LinkPropagation,
	LinkedGroup,
	MonitorApi,
	MonitorEvent,
	OpResult,
	WatchOptions,
	WithRefSupport
} from "./types.mts";

const DEFAULT_POLL_MS = 1000;

// Link runs *after* attachRefResolution + wrapMonitor mutate the modules in
// place, so at runtime `api.monitor.watch(ref, ...)` accepts any DeviceRef.
// We reflect that in the type so TS sees the wider contract too.
type AnyApi = {
	monitor: WithRefSupport<MonitorApi>;
	bulk: BulkApi;
};

class KasaLinkedGroup extends EventEmitter implements LinkedGroup {
	readonly refs: ReadonlyArray<DeviceRef>;
	readonly #watchers: DeviceMonitor[] = [];
	#stopped = false;

	constructor(api: AnyApi, refs: ReadonlyArray<DeviceRef>, options: LinkOptions) {
		super();
		this.refs = refs;
		const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
		const onAny = options.onAny ?? "all-on";
		const offAny = options.offAny ?? "all-off";

		for (const ref of refs) {
			const watcher = api.monitor.watch(ref, { intervalMs: pollMs });
			watcher.on("on", (event) => void this.#handle("on", ref, event, api, onAny));
			watcher.on("off", (event) => void this.#handle("off", ref, event, api, offAny));
			watcher.on("error", (err: Error) => this.emit("error", err));
			this.#watchers.push(watcher);
		}
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const w of this.#watchers) w.stop();
		this.emit("stop");
	}

	/** Decide whether to propagate, and which verb to send. */
	async #handle(
		direction: "on" | "off",
		source: DeviceRef,
		event: MonitorEvent,
		api: AnyApi,
		policy: "all-on" | "all-off" | "none"
	): Promise<void> {
		if (this.#stopped) return;
		// Drop self-induced echoes — the cause field handles the feedback loop
		// without any time-window race against legitimate user actions.
		if (event.cause === "self") return;
		if (policy === "none") return;
		const verb: "on" | "off" = policy === "all-on" ? "on" : "off";
		const targets = this.refs.filter((r) => r !== source);
		if (targets.length === 0) return;
		const results: OpResult[] = await api.bulk.switch[verb](targets);
		const payload: LinkPropagation = { source, verb, targets, results, at: Date.now() };
		this.emit("propagate", payload);
	}
}

/** Build the `api.link` surface from the live API object. */
export function buildLink(api: AnyApi): LinkApi {
	return {
		link(refs: ReadonlyArray<DeviceRef>, options: LinkOptions = {}): LinkedGroup {
			return new KasaLinkedGroup(api, refs, options);
		}
	};
}
