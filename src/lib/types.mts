/**
 * Shared types for the Kasa API modules.
 *
 * These types are used both by the API modules (for typing `self` from
 * `@cldmv/slothlet/runtime`) and by external consumers of the built API.
 */
import type { EventEmitter } from "node:events";

/** Connection target for a Kasa device on the local network. */
export interface DeviceTarget {
	/** Hostname or IP address of the device. */
	host: string;
	/** TCP/UDP port. Defaults to 9999 (legacy Kasa protocol). */
	port?: number;
	/** Transport timeout in milliseconds. */
	timeoutMs?: number;
	/**
	 * Verify writes against the device by reading the value back after the set.
	 * When `true`, a mutating command resolves `ok: false` if the read-back
	 * doesn't match the requested value. Overridden by a per-call
	 * {@link CommandOptions.confirm}; falls back to the global default set on
	 * `createKasaApi({ confirm })`.
	 */
	confirm?: boolean;
}

/** Per-call options accepted as the trailing argument on every command. */
export interface CommandOptions {
	/**
	 * Verify the write against the device by reading the value back. Overrides
	 * the target's `confirm` and the global default. See {@link DeviceTarget.confirm}.
	 */
	confirm?: boolean;
}

/**
 * A device reference accepted by the {@link DevicesApi} resolver:
 * an IP string, a MAC string, an alias (name) string, or an explicit target.
 */
export type DeviceRef = string | DeviceTarget;

/** Options that may be passed to a transport send. */
export interface SendOptions extends DeviceTarget {
	/** Transport: "tcp" (default) or "udp". */
	transport?: "tcp" | "udp";
}

/** A raw Kasa JSON command — protocol uses nested `{ namespace: { method: args } }` objects. */
export type KasaCommand = Record<string, Record<string, unknown>>;

/** Response from a Kasa device — same nested shape as the command. */
export type KasaResponse = Record<string, Record<string, unknown>>;

/**
 * Result of a device command.
 *
 * Commands never throw — they always resolve to an `OpResult`. Check `ok`.
 * `target`/`host` ride along so a caller firing many ops can map a result
 * (or an event) back to the device and action it came from.
 */
export interface OpResult<T = unknown> {
	/** Did the operation succeed? */
	ok: boolean;
	/** Operation path, e.g. `"plug.on"`. */
	op: string;
	/** Device the operation targeted. */
	target: DeviceTarget;
	/** Convenience alias for `target.host`. */
	host: string;
	/** Resolved value when `ok` — the device's parsed response. */
	value?: T;
	/** Error message when `!ok`. */
	error?: string;
	/** `false` when the failure was a connectivity error (timeout / refused / closed). */
	reachable: boolean;
	/** Wall-clock duration of the operation in ms. */
	durationMs: number;
}

/**
 * Payload of an `api.events` event — the result of one operation plus dispatch
 * detail.
 *
 * For device commands `target` and `host` are always present; for non-device
 * operations (`discovery.*` and `devices.*`) they are absent.
 */
export interface OpEvent<T = unknown> {
	/** Did the operation succeed? */
	ok: boolean;
	/** Operation path, e.g. `"plug.on"`, `"discovery.sweep"`. */
	op: string;
	/** Device target — present for device commands, absent for discovery/devices ops. */
	target?: DeviceTarget;
	/** Convenience alias for `target.host` — present for device commands. */
	host?: string;
	/** Resolved value when `ok`. */
	value?: T;
	/** Error message when `!ok`. */
	error?: string;
	/** `false` when the failure was a connectivity error. */
	reachable?: boolean;
	/** Wall-clock duration of the operation in ms. */
	durationMs: number;
	/** Module name, e.g. `"plug"`, `"discovery"`. */
	module: string;
	/** Method name, e.g. `"on"`, `"sweep"`. */
	method: string;
	/** Arguments passed beyond the target. */
	args: unknown[];
	/** `Date.now()` when the event fired. */
	at: number;
}

/** Listener for `api.events` operation events. */
export type OpEventListener = (event: OpEvent) => void;

/** SysInfo as returned by `system.get_sysinfo`. The schema differs slightly between models. */
export interface SysInfo {
	alias?: string;
	deviceId?: string;
	hwId?: string;
	hw_ver?: string;
	sw_ver?: string;
	model?: string;
	mic_type?: string;
	type?: string;
	mac?: string;
	/** Relay state on simple plugs (1 = on, 0 = off). */
	relay_state?: 0 | 1;
	/** RSSI (signal strength) in dBm. */
	rssi?: number;
	/** LED state (1 = off, 0 = on — TP-Link inverts this). */
	led_off?: 0 | 1;
	/** For multi-outlet strips like HS300: per-outlet metadata. */
	children?: Array<{ id: string; alias: string; state: 0 | 1 }>;
	/** Bulb light state. */
	light_state?: LightState;
	[key: string]: unknown;
}

/** Smart-bulb light state. */
export interface LightState {
	on_off: 0 | 1;
	mode?: string;
	brightness?: number;
	hue?: number;
	saturation?: number;
	color_temp?: number;
	ignore_default?: 0 | 1;
	transition_period?: number;
	/** Returned when the bulb is off — describes what state it will resume to. */
	dft_on_state?: Partial<LightState>;
}

/** Realtime energy reading from devices that support `emeter.get_realtime` (e.g. HS110, HS300, KP115). */
export interface EnergyRealtime {
	/** Voltage in volts. New firmware: `voltage_mv` (millivolts). */
	voltage?: number;
	voltage_mv?: number;
	/** Current in amps. New firmware: `current_ma` (milliamps). */
	current?: number;
	current_ma?: number;
	/** Power in watts. New firmware: `power_mw` (milliwatts). */
	power?: number;
	power_mw?: number;
	/** Cumulative energy in watt-hours. New firmware: `total_wh`. */
	total?: number;
	total_wh?: number;
	err_code?: number;
}

/** A device discovered via UDP broadcast. */
export interface DiscoveredDevice {
	host: string;
	port: number;
	sysInfo: SysInfo;
}

/** Options for {@link DiscoveryApi.discover}. */
export interface DiscoverOptions {
	/**
	 * Any IPv4 address on the target subnet (commonly the host's own IP).
	 * If provided, discovery binds to the matching local interface and sends
	 * the directed broadcast for that subnet. Falls back to a /24 assumption
	 * if no interface matches.
	 */
	baseIp?: string;
	/**
	 * Explicit broadcast address. Overrides auto-detection. Use this for
	 * `255.255.255.255` (limited broadcast) or a hand-picked subnet broadcast.
	 */
	broadcast?: string;
	/**
	 * Explicit interface bind address. Overrides auto-detection. Useful when
	 * a host has multiple NICs and you need to pin discovery to one.
	 */
	bindAddress?: string;
	/** UDP destination port. Defaults to 9999. */
	port?: number;
	/** How long to listen for responses, in ms. Defaults to 3000. */
	timeoutMs?: number;
	/** Stop after this many devices respond. */
	maxDevices?: number;
}

/** Options for {@link DiscoveryApi.sweep} — unicast CIDR scan (works across subnets). */
export interface SweepOptions {
	/** TCP port to probe. Defaults to 9999. */
	port?: number;
	/** Per-host probe timeout in ms. Defaults to 1000. */
	timeoutMs?: number;
	/** Number of hosts probed in parallel. Defaults to 64. */
	concurrency?: number;
}

/** Options for a {@link DevicesApi} scan — a {@link SweepOptions} plus the CIDR. */
export interface DevicesScanOptions extends SweepOptions {
	/** CIDR to sweep. Defaults to the `sweepCidr` passed to `createKasaApi`. */
	cidr?: string;
}

/** Result of broadcast-address auto-detection. */
export interface ResolvedBroadcast {
	/** Local interface IPv4 to bind to. */
	bindAddress: string;
	/** Directed broadcast address for that interface's subnet. */
	broadcast: string;
	/** Interface name (eth0, en0, etc). Informational. */
	interface: string;
	/** CIDR prefix length. Informational. */
	cidr: number;
}

/** Options for {@link MonitorApi.watch}. */
export interface WatchOptions {
	/** Relay poll interval in ms. Default 2000; floored at 250. */
	intervalMs?: number;
	/** Also poll the PIR sensor and emit `motion`/`clear` events. Default false. */
	motion?: boolean;
	/** PIR poll interval in ms when `motion` is set. Default 400; floored at 250. */
	motionIntervalMs?: number;
	/** Quiet period (ms) with no PIR trigger before `clear` fires. Default 5000. */
	motionClearMs?: number;
}

/** Options for {@link MonitorApi.watchMotion}. */
export interface WatchMotionOptions {
	/** PIR poll interval in ms. Default 400; floored at 250. */
	intervalMs?: number;
	/** Quiet period (ms) with no PIR trigger before `clear` fires. Default 5000. */
	clearMs?: number;
}

/**
 * A motion event emitted by a {@link DeviceMonitor} watching the PIR sensor.
 *
 * A PIR outputs an AC waveform, so one physical pass swings the ADC across
 * the trigger bar repeatedly. The watcher debounces that burst: `motion`
 * fires once when the burst starts, `clear` once the ADC has been quiet for
 * the configured window.
 */
export interface PirMotionEvent {
	/** Device host that produced the event. */
	host: string;
	/** `true` for a `motion` event, `false` for a `clear` event. */
	detected: boolean;
	/** Motion magnitude at this poll — ±% of ADC swing (see {@link PirStatus}). */
	percent: number;
	/** Raw PIR ADC reading at this poll. */
	adcValue: number;
	/** `Date.now()` of the poll. */
	at: number;
	/** On a `clear` event: how long motion was active, in ms. */
	durationMs?: number;
}

/** A device state event emitted by a {@link DeviceMonitor}. */
export interface MonitorEvent {
	/** Device host that produced the event. */
	host: string;
	/** Relay state at this poll (1 = on, 0 = off). */
	relayState: 0 | 1;
	/** The transition direction, or `null` for the initial baseline `"state"` event. */
	changedTo: 0 | 1 | null;
	/** Seconds the relay has been on (0 when off). Small value = freshly turned on. */
	onTime: number;
	/** Device `active_mode` (e.g. "none", "count_down"). */
	activeMode: string;
	/**
	 * Cause of an on-transition: `"motion"` when the watcher is also polling
	 * the PIR (`watch` with `motion: true`) and motion was active around the
	 * transition; otherwise `"unknown"` — the legacy protocol can't tell a
	 * motion trigger from a manual press on its own.
	 */
	triggeredBy: "motion" | "unknown";
	/** `Date.now()` of the poll. */
	at: number;
	/** Full raw sysinfo from the poll. */
	sysInfo: SysInfo;
}

/**
 * Poll-based device watcher. An `EventEmitter` that emits:
 *   - `"state"`  once — the initial relay reading (`changedTo` is `null`)
 *   - `"on"`     when the relay goes 0→1
 *   - `"off"`    when the relay goes 1→0
 *   - `"change"` on either relay transition
 *   - `"motion"` when the PIR starts detecting motion (motion watch only)
 *   - `"clear"`  when the PIR has been quiet for the clear window (motion watch only)
 *   - `"error"`  on a failed poll (polling continues)
 *   - `"stop"`   when {@link DeviceMonitor.stop} is called
 *
 * Relay events carry a {@link MonitorEvent}; `motion`/`clear` carry a
 * {@link PirMotionEvent}; `error` carries an `Error`.
 */
export interface DeviceMonitor extends EventEmitter {
	/** Stop polling. Emits `"stop"`. Idempotent. */
	stop(): void;
}

/** Button-action mode for a dimmer's double-click / long-press. Devices may report others. */
export type DimmerActionMode = "none" | "instant_on_off" | "gentle_on_off" | "preset" | (string & {});

/** Dimmer tuning parameters as returned by `smartlife.iot.dimmer.get_dimmer_parameters`. */
export interface DimmerParameters {
	/** Lowest brightness the load will hold without flickering. */
	minThreshold?: number;
	/** Fade-in time (ms) when switched on. */
	fadeOnTime?: number;
	/** Fade-out time (ms) when switched off. */
	fadeOffTime?: number;
	/** Gentle (slow) on-ramp time (ms). */
	gentleOnTime?: number;
	/** Gentle (slow) off-ramp time (ms). */
	gentleOffTime?: number;
	/** Ramp rate used for transitions. */
	rampRate?: number;
	/** Configured bulb type the dimmer is tuned for. */
	bulb_type?: number;
	err_code?: number;
	[key: string]: unknown;
}

/** Motion (PIR) sensor configuration from `smartlife.iot.PIR.get_config`. */
export interface PirConfig {
	/** 1 = sensor enabled, 0 = disabled. */
	enable?: 0 | 1;
	version?: string;
	/** Index of the active sensitivity preset. */
	trigger_index?: number;
	/** Cooldown (ms) after a trigger before re-arming. */
	cold_time?: number;
	min_adc?: number;
	max_adc?: number;
	/** Per-preset ADC thresholds. */
	array?: number[];
	err_code?: number;
	[key: string]: unknown;
}

/**
 * Live motion state, computed from a PIR config + ADC reading.
 *
 * Uses python-kasa's calibration-free model: the reference point is the
 * fixed midpoint of the device's declared ADC range (a hardware constant,
 * not a learned baseline), and the trigger bar is the device's own
 * configured sensitivity threshold.
 */
export interface PirStatus {
	/** Motion detected right now — python-kasa's `pir_triggered`. */
	triggered: boolean;
	/** Motion magnitude as ±% of the sensor's available ADC swing (0 at rest, ±100 railed). */
	percent: number;
	/** Raw ADC reading from `smartlife.iot.PIR.get_adc_value`. */
	adcValue: number;
}

/** Ambient-light (LAS) sensor configuration from `smartlife.iot.LAS.get_config`. */
export interface AmbientLightConfig {
	/** 1 = ambient-light gating enabled, 0 = disabled. */
	enable?: 0 | 1;
	/** Index of the active darkness-threshold preset. */
	dark_index?: number;
	/** Per-preset lux/ADC levels. */
	array?: number[];
	devs?: unknown;
	err_code?: number;
	[key: string]: unknown;
}

/** One device's entry in a {@link SignalApi.report}. */
export interface SignalEntry {
	host: string;
	alias: string;
	model: string;
	/** RSSI in dBm (closer to 0 is stronger), or `null` if the device didn't answer. */
	rssi: number | null;
	/** Bucketed signal quality. */
	quality: "excellent" | "good" | "fair" | "weak" | "unknown";
	/** Whether the device responded. */
	reachable: boolean;
}

/** Options for {@link SignalApi.report}. */
export interface SignalReportOptions {
	/** Scan this CIDR via unicast sweep. */
	cidr?: string;
	/** Or report on this explicit device list. */
	devices?: DeviceTarget[];
	/** Probe concurrency. Default 32. */
	concurrency?: number;
	/** Per-device timeout in ms. Default 1500. */
	timeoutMs?: number;
}

/**
 * Shape of `self` inside an API module. Slothlet flattens
 * `<folder>/<folder>.mts` into a single namespace, so e.g. `protocol/protocol.mts`
 * becomes `self.protocol.*`.
 */
export interface SelfApi {
	protocol: ProtocolApi;
	discovery: DiscoveryApi;
	events: EventsApi;
	device: DeviceApi;
	plug: PlugApi;
	switch: SwitchApi;
	dimmer: DimmerApi;
	motion: MotionApi;
	bulb: BulbApi;
	energy: EnergyApi;
	schedule: ScheduleApi;
	monitor: MonitorApi;
}

export interface ProtocolApi {
	encryptTcp(data: string): Buffer;
	decryptTcp(frame: Buffer): string;
	encryptUdp(data: string): Buffer;
	decryptUdp(payload: Buffer): string;
	send(target: DeviceTarget, command: KasaCommand): Promise<KasaResponse>;
	sendUdp(target: DeviceTarget, command: KasaCommand): Promise<KasaResponse>;
}

export interface DiscoveryApi {
	/**
	 * Broadcast discovery — local subnet only (broadcasts don't cross routers).
	 * Never throws — resolves to `[]` on failure and emits an `error` event.
	 */
	discover(options?: DiscoverOptions): Promise<DiscoveredDevice[]>;
	/**
	 * Unicast CIDR sweep — probes every host in `cidr` with a TCP `get_sysinfo`.
	 * Works across subnets/VLANs since each probe is a routed unicast connection.
	 * Never throws — resolves to `[]` on a bad CIDR / oversized range and emits
	 * an `error` event.
	 */
	sweep(cidr: string, options?: SweepOptions): Promise<DiscoveredDevice[]>;
	/**
	 * Resolve the broadcast/bind addresses discovery would use for a given base
	 * IP. Returns `null` (instead of throwing) when no usable interface exists.
	 */
	resolveBroadcast(baseIp?: string): ResolvedBroadcast | null;
}

/**
 * Shared event bus. Every command emits, on completion, across three tiers:
 *   - general  — `"op"` (every operation), `"success"`, `"error"`
 *   - path     — the full op path, e.g. `"plug.on"`, `"dimmer.brightness.set"`
 *   - specific — the leaf action, e.g. `"on"` (fires for plug.on, switch.on,
 *                bulb.on, …), `"set"`, `"get"`, `"toggle"`
 *
 * `on` / `once` / `off` also accept a **glob** (`*`) matched against the op
 * path — `"plug.*"`, `"*.set"`, `"motion.*"`.
 *
 * Commands never throw; failures arrive as `"error"` events and as
 * `OpResult` return values with `ok: false`.
 */
export interface EventsApi {
	/** Subscribe to an event — a literal name or a `*` glob over the op path. */
	on(event: string, listener: OpEventListener): void;
	/** Subscribe once — a literal name or a `*` glob. */
	once(event: string, listener: OpEventListener): void;
	/** Unsubscribe — pass the same `event` (literal or glob) used to subscribe. */
	off(event: string, listener: OpEventListener): void;
	/** The underlying EventEmitter, for advanced use. */
	emitter: EventEmitter;
	/**
	 * Set bus-level defaults. `confirm` is the global default for verified
	 * writes — overridden per-target and per-call. Called by `createKasaApi`.
	 */
	configure(options: { confirm?: boolean }): void;
	/**
	 * Run a unit of work as a tracked operation: executes `work`, captures
	 * success/failure into an {@link OpResult} (never throws), emits events,
	 * and returns the result. Used internally by every command.
	 *
	 * When `opts.verify` is provided and the effective `confirm` is true
	 * (per-call `opts.confirm` > `target.confirm` > the global from
	 * {@link configure}), the verify callback runs after a successful
	 * `work()`; if it returns `false` the result becomes `ok: false`.
	 */
	run<T>(
		op: string,
		target: DeviceTarget,
		args: unknown[],
		work: () => Promise<T> | T,
		opts?: { verify?: (() => Promise<boolean>) | undefined; confirm?: boolean | undefined }
	): Promise<OpResult<T>>;
	/**
	 * Run an operation that isn't addressed to a device (discovery, devices).
	 * Same event/no-throw contract as {@link run}, but the emitted event has
	 * no `target`/`host` and the function resolves to the raw value (or the
	 * supplied `fallback` on failure) rather than an `OpResult`.
	 */
	runUntargeted<T>(op: string, args: unknown[], work: () => Promise<T> | T, fallback: T): Promise<T>;
}

/** Read-only resource leaf. */
export interface ResourceGet<T> {
	get(target: DeviceTarget): Promise<OpResult<T>>;
}

/** A scalar resource leaf with a single-argument setter (`get` may be derived). */
export interface ScalarResource<T, A = T> {
	get(target: DeviceTarget): Promise<OpResult<T>>;
	set(target: DeviceTarget, value: A, options?: CommandOptions): Promise<OpResult>;
}

/** Generic device commands, addressed as resources. */
export interface DeviceApi {
	/** Full device system information. */
	info: ResourceGet<SysInfo>;
	/** Device alias / display name. */
	alias: ScalarResource<string | undefined, string>;
	/** Status LED — `get`/`set` are in terms of LED-on (the device stores `led_off`). */
	led: ScalarResource<boolean>;
	/** Reboot the device after an optional delay (default 1s). */
	reboot(target: DeviceTarget, delaySec?: number, options?: CommandOptions): Promise<OpResult>;
}

/** Smart-plug relay control. */
export interface PlugApi {
	/** Relay power state. `set` routes to `on`/`off`. */
	power: ScalarResource<0 | 1, boolean>;
	on(target: DeviceTarget, options?: CommandOptions): Promise<OpResult>;
	off(target: DeviceTarget, options?: CommandOptions): Promise<OpResult>;
	toggle(target: DeviceTarget, options?: CommandOptions): Promise<OpResult<0 | 1>>;
	/** Per-outlet control for multi-outlet strips (HS300, KP200). */
	children: {
		set(target: DeviceTarget, childIds: string[], on: boolean, options?: CommandOptions): Promise<OpResult>;
	};
}

/** Wall light-switch control. Protocol-identical to {@link PlugApi}. */
export interface SwitchApi {
	/** Relay power state. `set` routes to `on`/`off`. */
	power: ScalarResource<0 | 1, boolean>;
	on(target: DeviceTarget, options?: CommandOptions): Promise<OpResult>;
	off(target: DeviceTarget, options?: CommandOptions): Promise<OpResult>;
	toggle(target: DeviceTarget, options?: CommandOptions): Promise<OpResult<0 | 1>>;
}

/** Dimmer-switch control (HS220, KS220, KS230, ES20M). On/off is via `plug`/`switch`. */
export interface DimmerApi {
	/** Brightness 1..100. `set` takes an optional fade duration (ms). */
	brightness: {
		get(target: DeviceTarget): Promise<OpResult<number | undefined>>;
		set(target: DeviceTarget, level: number, durationMs?: number, options?: CommandOptions): Promise<OpResult>;
	};
	/** Full dimmer tuning block. */
	parameters: ResourceGet<DimmerParameters>;
	/** Hard fade ramp times (ms). */
	fade: {
		on: ScalarResource<number | undefined, number>;
		off: ScalarResource<number | undefined, number>;
	};
	/** Gentle (slow) ramp times (ms). */
	gentle: {
		on: ScalarResource<number | undefined, number>;
		off: ScalarResource<number | undefined, number>;
	};
	/** Physical double-click action. */
	doubleClick: {
		set(target: DeviceTarget, mode: DimmerActionMode, brightness?: number, options?: CommandOptions): Promise<OpResult>;
	};
	/** Physical long-press action. */
	longPress: {
		set(target: DeviceTarget, mode: DimmerActionMode, brightness?: number, options?: CommandOptions): Promise<OpResult>;
	};
}

/** Motion (PIR) and ambient-light (LAS) sensors on motion switches (KS200M, KS220M, ES20M). */
export interface MotionApi {
	pir: {
		/** Full PIR config. */
		get(target: DeviceTarget): Promise<OpResult<PirConfig>>;
		/** Enable / disable the motion sensor. */
		set(target: DeviceTarget, enabled: boolean, options?: CommandOptions): Promise<OpResult>;
		/** Motion-sensitivity preset index. */
		sensitivity: ScalarResource<number | undefined, number>;
		/** Re-arm cooldown (ms) after a trigger. */
		cooldown: ScalarResource<number | undefined, number>;
		/** Live ADC reading — a real device call, not derived from `pir.get`. */
		adc: ResourceGet<number>;
		/** Computed live motion state — merges `get_config` + `get_adc_value`. */
		status: ResourceGet<PirStatus>;
		/** Whether motion is detected right now — the boolean from {@link PirStatus}. */
		triggered: ResourceGet<boolean>;
	};
	ambient: {
		/** Full ambient-light (LAS) config. */
		get(target: DeviceTarget): Promise<OpResult<AmbientLightConfig>>;
		/** Ambient-light gating on/off. */
		enabled: ScalarResource<boolean>;
		/** Darkness-threshold preset index. */
		darkThreshold: ScalarResource<number | undefined, number>;
	};
}

/** Smart-bulb control (LB-series, KL-series). */
export interface BulbApi {
	/** Full light state. */
	state: {
		get(target: DeviceTarget): Promise<OpResult<LightState>>;
		set(target: DeviceTarget, state: Partial<LightState>, options?: CommandOptions): Promise<OpResult<LightState>>;
	};
	/** On/off state. `set` routes to `on`/`off`. */
	power: ScalarResource<boolean>;
	on(target: DeviceTarget, transitionMs?: number, options?: CommandOptions): Promise<OpResult>;
	off(target: DeviceTarget, transitionMs?: number, options?: CommandOptions): Promise<OpResult>;
	/** Brightness 1..100. `set` takes an optional transition (ms). */
	brightness: {
		get(target: DeviceTarget): Promise<OpResult<number | undefined>>;
		set(target: DeviceTarget, level: number, transitionMs?: number, options?: CommandOptions): Promise<OpResult>;
	};
	/** Color as HSV. `set`'s `value` is brightness (defaults 100). */
	color: {
		get(target: DeviceTarget): Promise<OpResult<{ hue: number; saturation: number; value: number }>>;
		set(
			target: DeviceTarget,
			hsv: { hue: number; saturation: number; value?: number },
			transitionMs?: number,
			options?: CommandOptions
		): Promise<OpResult>;
	};
	/** White color temperature in Kelvin. */
	colorTemp: {
		get(target: DeviceTarget): Promise<OpResult<number | undefined>>;
		set(target: DeviceTarget, kelvin: number, transitionMs?: number, options?: CommandOptions): Promise<OpResult>;
	};
}

/** Energy monitoring (HS110, HS300, KP115, KP125). */
export interface EnergyApi {
	/** Instantaneous voltage / current / power reading. */
	realtime: ResourceGet<EnergyRealtime>;
	/** Historical energy statistics. */
	stats: {
		daily: {
			get(target: DeviceTarget, year: number, month: number): Promise<OpResult<Array<Record<string, number>>>>;
		};
		monthly: {
			get(target: DeviceTarget, year: number): Promise<OpResult<Array<Record<string, number>>>>;
		};
		/** Wipe the device's cumulative counters. Irreversible. */
		erase(target: DeviceTarget, options?: CommandOptions): Promise<OpResult>;
	};
}

/** On-device schedule (timer) rules. */
export interface ScheduleApi {
	rules: {
		get(target: DeviceTarget): Promise<OpResult<unknown>>;
		/** Remove every schedule rule. */
		clear(target: DeviceTarget, options?: CommandOptions): Promise<OpResult>;
	};
}

/** Poll-based device monitoring — detect when a device turns on/off or sees motion. */
export interface MonitorApi {
	/**
	 * Watch a device's relay for on/off transitions. Pass `{ motion: true }`
	 * to also poll the PIR and emit `motion`/`clear`. Returns a
	 * {@link DeviceMonitor} EventEmitter; call `.stop()` to end.
	 */
	watch(target: DeviceTarget, options?: WatchOptions): DeviceMonitor;
	/**
	 * Watch only the PIR motion sensor — debounced `motion`/`clear` events,
	 * no relay polling. For motion switches (KS200M, KS220M, ES20M).
	 */
	watchMotion(target: DeviceTarget, options?: WatchMotionOptions): DeviceMonitor;
}

/**
 * Turn a single-device command tree into its bulk twin, recursively: every
 * leaf `(target, ...rest) => Promise<OpResult<V>>` becomes
 * `(targets[], ...rest) => Promise<OpResult<V>[]>`; nested resource objects
 * are mirrored in place.
 */
export type Bulkified<M> = {
	[K in keyof M]: M[K] extends (target: DeviceTarget, ...rest: infer R) => Promise<OpResult<infer V>>
		? (targets: DeviceTarget[], ...rest: R) => Promise<Array<OpResult<V>>>
		: M[K] extends object
			? Bulkified<M[K]>
			: M[K];
};

/**
 * Dynamic bulk layer — mirrors every device-command module. Each method takes
 * `targets[]` instead of one target, runs them with bounded concurrency, and
 * resolves to one {@link OpResult} per device (including non-responders).
 */
export interface BulkApi {
	device: Bulkified<DeviceApi>;
	plug: Bulkified<PlugApi>;
	switch: Bulkified<SwitchApi>;
	dimmer: Bulkified<DimmerApi>;
	motion: Bulkified<MotionApi>;
	bulb: Bulkified<BulbApi>;
	energy: Bulkified<EnergyApi>;
	schedule: Bulkified<ScheduleApi>;
}

/** Network-health reporting. */
export interface SignalApi {
	/** Collect RSSI for a CIDR / device list / local broadcast, sorted best→worst. */
	report(options?: SignalReportOptions): Promise<SignalEntry[]>;
}

/**
 * Device discovery cache + resolver.
 *
 * The underlying CIDR sweep runs once and is cached, so a long-running app
 * can resolve a device by MAC / alias / IP repeatedly without re-scanning
 * the network. `refresh()` re-scans on demand.
 */
export interface DevicesApi {
	/**
	 * Resolve a MAC / alias (name) / IP — or a {@link DeviceTarget} passthrough —
	 * to a {@link DeviceTarget}. An IP resolves directly; a MAC or name is looked
	 * up in the cached sweep. Resolves to `null` (never throws) when a MAC/name
	 * isn't in the cache after a re-sweep; emits a `devices.resolve` event.
	 */
	resolve(ref: DeviceRef): Promise<DeviceTarget | null>;
	/** Look up the full {@link DiscoveredDevice} for a ref; `undefined` if not cached. */
	find(ref: DeviceRef): Promise<DiscoveredDevice | undefined>;
	/** Cached device list — sweeps once on first use, then serves the cache. */
	list(options?: DevicesScanOptions): Promise<DiscoveredDevice[]>;
	/** Force a re-sweep, replacing the cache. */
	refresh(options?: DevicesScanOptions): Promise<DiscoveredDevice[]>;
}
