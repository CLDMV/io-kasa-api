/**
 * Poll-based device monitoring.
 *
 * The Kasa port-9999 protocol is request/response only — no push, no
 * subscribe — so "tell me when this device turns on" means polling
 * `system.get_sysinfo` on an interval and diffing `relay_state`.
 *
 * `watch()` returns an `EventEmitter`. Slothlet's wrapper excludes
 * `EventEmitter` from proxy-wrapping, so the caller gets the real emitter
 * and `.on(...)` / `.stop()` work directly.
 */
import { EventEmitter } from "node:events";
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceMonitor, DeviceTarget, MonitorEvent, SelfApi, SysInfo, WatchOptions } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 250;

/**
 * Best-effort guess at what caused an on-transition.
 *
 * The motion-sensing switches (ES20M, KS200M/KS220M) run an auto-off
 * countdown when the PIR fires, which surfaces as `active_mode: "count_down"`.
 * A manual press leaves `active_mode: "none"`. Anything else is unknown.
 */
function inferTrigger(sysInfo: SysInfo): "motion" | "manual" | "unknown" {
	const mode = String(sysInfo.active_mode ?? "");
	if (mode === "count_down") return "motion";
	if (mode === "none") return "manual";
	return "unknown";
}

class KasaDeviceMonitor extends EventEmitter {
	readonly #target: DeviceTarget;
	readonly #intervalMs: number;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#last: 0 | 1 | null = null;

	constructor(target: DeviceTarget, intervalMs: number) {
		super();
		this.#target = target;
		this.#intervalMs = intervalMs;
	}

	/** Begin polling. The first poll is deferred a tick so the caller can attach listeners. */
	start(): void {
		this.#timer = setTimeout(() => void this.#tick(), 0);
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.emit("stop");
	}

	async #tick(): Promise<void> {
		if (this.#stopped) return;
		try {
			// getSysInfo never throws — it resolves to an OpResult.
			const result = await self.device.getSysInfo(this.#target);
			if (!result.ok || !result.value) {
				// Transient unreachability shouldn't kill the watcher — report and keep polling.
				this.emit("error", new Error(result.error ?? "poll failed"));
			} else {
				const sysInfo = result.value;
				const relayState: 0 | 1 = sysInfo.relay_state === 1 ? 1 : 0;
				const event: MonitorEvent = {
					host: this.#target.host,
					relayState,
					changedTo: null,
					onTime: Number(sysInfo.on_time ?? 0),
					activeMode: String(sysInfo.active_mode ?? ""),
					triggeredBy: inferTrigger(sysInfo),
					at: Date.now(),
					sysInfo
				};
				if (this.#last === null) {
					this.emit("state", event);
				} else if (relayState !== this.#last) {
					event.changedTo = relayState;
					this.emit("change", event);
					this.emit(relayState === 1 ? "on" : "off", event);
				}
				this.#last = relayState;
			}
		} catch (err) {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		} finally {
			if (!this.#stopped) {
				this.#timer = setTimeout(() => void this.#tick(), this.#intervalMs);
			}
		}
	}
}

/**
 * Start watching a device for relay on/off transitions.
 *
 * @param target - Device to poll.
 * @param options - `intervalMs` poll cadence (default 2000, floor 250).
 * @returns A {@link DeviceMonitor} EventEmitter. See its docs for events; call `.stop()` to end.
 *
 * @example
 * const w = api.monitor.watch({ host: "10.8.1.250" }, { intervalMs: 3000 });
 * w.on("on", (ev) => console.log(`on via ${ev.triggeredBy}`));
 * w.on("off", () => console.log("off"));
 */
export function watch(target: DeviceTarget, options: WatchOptions = {}): DeviceMonitor {
	const intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS);
	const monitor = new KasaDeviceMonitor(target, intervalMs);
	monitor.start();
	return monitor;
}
