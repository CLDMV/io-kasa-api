/**
 * Poll-based device monitoring.
 *
 * The Kasa port-9999 protocol is request/response only — no push, no
 * subscribe — so "tell me when this device changes" means polling.
 *
 * A monitor runs up to two independent pollers:
 *   - relay  — polls `system.get_sysinfo`, diffs `relay_state`, emits
 *              `state` / `on` / `off` / `change`.
 *   - motion — polls `motion.pir.status`, debounces the PIR's chattery
 *              ADC swings, emits `motion` / `clear`.
 *
 * `watch()` runs the relay poller (and the motion poller too if
 * `motion: true`). `watchMotion()` runs only the motion poller.
 *
 * Both return an `EventEmitter`. Slothlet's wrapper excludes `EventEmitter`
 * from proxy-wrapping, so the caller gets the real emitter and `.on(...)` /
 * `.stop()` work directly.
 */
import { EventEmitter } from "node:events";
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type {
	DeviceMonitor,
	DeviceTarget,
	MonitorEvent,
	PirMotionEvent,
	SelfApi,
	WatchMotionOptions,
	WatchOptions
} from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

const DEFAULT_RELAY_INTERVAL_MS = 2000;
const DEFAULT_MOTION_INTERVAL_MS = 400;
const DEFAULT_MOTION_CLEAR_MS = 5000;
const MIN_INTERVAL_MS = 250;

/** Which pollers a monitor runs, and at what cadence. */
interface MonitorConfig {
	relay: boolean;
	motion: boolean;
	relayIntervalMs: number;
	motionIntervalMs: number;
	motionClearMs: number;
}

class KasaDeviceMonitor extends EventEmitter {
	readonly #target: DeviceTarget;
	readonly #config: MonitorConfig;
	#relayTimer: ReturnType<typeof setTimeout> | null = null;
	#motionTimer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	/** Last seen relay state, or `null` before the first poll. */
	#lastRelay: 0 | 1 | null = null;
	/** Whether the PIR is currently inside a (debounced) motion burst. */
	#motionActive = false;
	/** `Date.now()` of the most recent PIR trigger. */
	#lastTriggerAt = 0;
	/** `Date.now()` when the current motion burst began. */
	#motionStartedAt = 0;

	constructor(target: DeviceTarget, config: MonitorConfig) {
		super();
		this.#target = target;
		this.#config = config;
	}

	/** Begin polling. First polls are deferred a tick so the caller can attach listeners. */
	start(): void {
		if (this.#config.relay) this.#relayTimer = setTimeout(() => void this.#tickRelay(), 0);
		if (this.#config.motion) this.#motionTimer = setTimeout(() => void this.#tickMotion(), 0);
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#relayTimer) clearTimeout(this.#relayTimer);
		if (this.#motionTimer) clearTimeout(this.#motionTimer);
		this.#relayTimer = null;
		this.#motionTimer = null;
		this.emit("stop");
	}

	/** Was PIR motion active at (or just before) `at`? Used to attribute a relay on-transition. */
	#motionRecently(at: number): boolean {
		return this.#config.motion && (this.#motionActive || at - this.#lastTriggerAt < this.#config.motionClearMs);
	}

	async #tickRelay(): Promise<void> {
		if (this.#stopped) return;
		try {
			// info.get never throws — it resolves to an OpResult.
			const result = await self.device.info.get(this.#target);
			if (!result.ok || !result.value) {
				// Transient unreachability shouldn't kill the watcher — report and keep polling.
				this.emit("error", new Error(result.error ?? "poll failed"));
			} else {
				const sysInfo = result.value;
				const relayState: 0 | 1 = sysInfo.relay_state === 1 ? 1 : 0;
				const at = Date.now();
				const event: MonitorEvent = {
					host: this.#target.host,
					relayState,
					changedTo: null,
					onTime: Number(sysInfo.on_time ?? 0),
					activeMode: String(sysInfo.active_mode ?? ""),
					triggeredBy: this.#motionRecently(at) ? "motion" : "unknown",
					at,
					sysInfo
				};
				if (this.#lastRelay === null) {
					this.emit("state", event);
				} else if (relayState !== this.#lastRelay) {
					event.changedTo = relayState;
					this.emit("change", event);
					this.emit(relayState === 1 ? "on" : "off", event);
				}
				this.#lastRelay = relayState;
			}
		} catch (err) {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		} finally {
			if (!this.#stopped) {
				this.#relayTimer = setTimeout(() => void this.#tickRelay(), this.#config.relayIntervalMs);
			}
		}
	}

	async #tickMotion(): Promise<void> {
		if (this.#stopped) return;
		try {
			const result = await self.motion.pir.status.get(this.#target);
			if (!result.ok || !result.value) {
				this.emit("error", new Error(result.error ?? "motion poll failed"));
			} else {
				const { triggered, percent, adcValue } = result.value;
				const at = Date.now();
				if (triggered) {
					this.#lastTriggerAt = at;
					// Burst start — emit `motion` once, then stay quiet until it clears.
					if (!this.#motionActive) {
						this.#motionActive = true;
						this.#motionStartedAt = at;
						const event: PirMotionEvent = { host: this.#target.host, detected: true, percent, adcValue, at };
						this.emit("motion", event);
					}
				} else if (this.#motionActive && at - this.#lastTriggerAt >= this.#config.motionClearMs) {
					// Quiet long enough — the burst is over.
					this.#motionActive = false;
					const event: PirMotionEvent = {
						host: this.#target.host,
						detected: false,
						percent,
						adcValue,
						at,
						durationMs: this.#lastTriggerAt - this.#motionStartedAt
					};
					this.emit("clear", event);
				}
			}
		} catch (err) {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		} finally {
			if (!this.#stopped) {
				this.#motionTimer = setTimeout(() => void this.#tickMotion(), this.#config.motionIntervalMs);
			}
		}
	}
}

/**
 * Watch a device's relay for on/off transitions.
 *
 * @param target - Device to poll.
 * @param options - `intervalMs` relay cadence (default 2000, floor 250).
 *   Set `motion: true` to also poll the PIR and emit `motion`/`clear`
 *   (tuned with `motionIntervalMs` / `motionClearMs`).
 * @returns A {@link DeviceMonitor} EventEmitter. See its docs for events; call `.stop()` to end.
 *
 * @example
 * const w = api.monitor.watch({ host: "10.8.1.250" }, { motion: true });
 * w.on("on", (ev) => console.log(`on via ${ev.triggeredBy}`));
 * w.on("motion", () => console.log("movement"));
 */
export function watch(target: DeviceTarget, options: WatchOptions = {}): DeviceMonitor {
	const monitor = new KasaDeviceMonitor(target, {
		relay: true,
		motion: options.motion ?? false,
		relayIntervalMs: Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_RELAY_INTERVAL_MS),
		motionIntervalMs: Math.max(MIN_INTERVAL_MS, options.motionIntervalMs ?? DEFAULT_MOTION_INTERVAL_MS),
		motionClearMs: Math.max(0, options.motionClearMs ?? DEFAULT_MOTION_CLEAR_MS)
	});
	monitor.start();
	return monitor;
}

/**
 * Watch only the PIR motion sensor — debounced `motion`/`clear` events.
 *
 * A PIR's ADC swings repeatedly across the trigger bar during one physical
 * pass; this collapses that burst into a single `motion` event, then a
 * `clear` once the sensor has been quiet for `clearMs`.
 *
 * @param target - Motion-switch device to poll (KS200M, KS220M, ES20M).
 * @param options - `intervalMs` PIR cadence (default 400, floor 250);
 *   `clearMs` quiet window before `clear` (default 5000).
 * @returns A {@link DeviceMonitor} EventEmitter; call `.stop()` to end.
 *
 * @example
 * const w = api.monitor.watchMotion({ host: "10.8.1.250" }, { clearMs: 8000 });
 * w.on("motion", (ev) => console.log(`motion @ ${ev.percent.toFixed(0)}%`));
 * w.on("clear", (ev) => console.log(`still for ${ev.durationMs}ms of motion`));
 */
export function watchMotion(target: DeviceTarget, options: WatchMotionOptions = {}): DeviceMonitor {
	const monitor = new KasaDeviceMonitor(target, {
		relay: false,
		motion: true,
		relayIntervalMs: DEFAULT_RELAY_INTERVAL_MS,
		motionIntervalMs: Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_MOTION_INTERVAL_MS),
		motionClearMs: Math.max(0, options.clearMs ?? DEFAULT_MOTION_CLEAR_MS)
	});
	monitor.start();
	return monitor;
}
