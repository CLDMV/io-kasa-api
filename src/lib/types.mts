/**
 * Shared types for the Kasa API modules.
 *
 * These types are used both by the API modules (for typing `self` from
 * `@cldmv/slothlet/runtime`) and by external consumers of the built API.
 */

/** Connection target for a Kasa device on the local network. */
export interface DeviceTarget {
	/** Hostname or IP address of the device. */
	host: string;
	/** TCP/UDP port. Defaults to 9999 (legacy Kasa protocol). */
	port?: number;
	/** Transport timeout in milliseconds. */
	timeoutMs?: number;
}

/** Options that may be passed to a transport send. */
export interface SendOptions extends DeviceTarget {
	/** Transport: "tcp" (default) or "udp". */
	transport?: "tcp" | "udp";
}

/** A raw Kasa JSON command — protocol uses nested `{ namespace: { method: args } }` objects. */
export type KasaCommand = Record<string, Record<string, unknown>>;

/** Response from a Kasa device — same nested shape as the command. */
export type KasaResponse = Record<string, Record<string, unknown>>;

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

/**
 * Shape of `self` inside an API module. Slothlet flattens
 * `<folder>/<folder>.mts` into a single namespace, so e.g. `protocol/protocol.mts`
 * becomes `self.protocol.*`.
 */
export interface SelfApi {
	protocol: ProtocolApi;
	discovery: DiscoveryApi;
	device: DeviceApi;
	plug: PlugApi;
	switch: SwitchApi;
	dimmer: DimmerApi;
	motion: MotionApi;
	bulb: BulbApi;
	energy: EnergyApi;
	schedule: ScheduleApi;
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
	/** Broadcast discovery — local subnet only (broadcasts don't cross routers). */
	discover(options?: DiscoverOptions): Promise<DiscoveredDevice[]>;
	/**
	 * Unicast CIDR sweep — probes every host in `cidr` with a TCP `get_sysinfo`.
	 * Works across subnets/VLANs since each probe is a routed unicast connection.
	 */
	sweep(cidr: string, options?: SweepOptions): Promise<DiscoveredDevice[]>;
	/** Resolve the broadcast/bind addresses discovery would use for a given base IP. */
	resolveBroadcast(baseIp?: string): ResolvedBroadcast;
}

export interface DeviceApi {
	getSysInfo(target: DeviceTarget): Promise<SysInfo>;
	setAlias(target: DeviceTarget, alias: string): Promise<void>;
	reboot(target: DeviceTarget, delaySec?: number): Promise<void>;
	setLedOff(target: DeviceTarget, off: boolean): Promise<void>;
}

export interface PlugApi {
	on(target: DeviceTarget): Promise<void>;
	off(target: DeviceTarget): Promise<void>;
	toggle(target: DeviceTarget): Promise<0 | 1>;
	getState(target: DeviceTarget): Promise<0 | 1>;
	setState(target: DeviceTarget, on: boolean): Promise<void>;
	/** Per-outlet control for multi-outlet strips like HS300. `childIds` are the device IDs of the outlets. */
	setChildState(target: DeviceTarget, childIds: string[], on: boolean): Promise<void>;
}

export interface BulbApi {
	on(target: DeviceTarget, transitionMs?: number): Promise<void>;
	off(target: DeviceTarget, transitionMs?: number): Promise<void>;
	getLightState(target: DeviceTarget): Promise<LightState>;
	setLightState(target: DeviceTarget, state: Partial<LightState>): Promise<LightState>;
	setBrightness(target: DeviceTarget, brightness: number, transitionMs?: number): Promise<void>;
	setColor(target: DeviceTarget, hsv: { hue: number; saturation: number; value?: number }, transitionMs?: number): Promise<void>;
	setColorTemp(target: DeviceTarget, kelvin: number, transitionMs?: number): Promise<void>;
}

export interface EnergyApi {
	getRealtime(target: DeviceTarget): Promise<EnergyRealtime>;
	/** Daily statistics for a given month/year. */
	getDayStats(target: DeviceTarget, year: number, month: number): Promise<Array<Record<string, number>>>;
	/** Monthly statistics for a given year. */
	getMonthStats(target: DeviceTarget, year: number): Promise<Array<Record<string, number>>>;
	/** Erase the cumulative counters. */
	eraseStats(target: DeviceTarget): Promise<void>;
}

export interface ScheduleApi {
	getRules(target: DeviceTarget): Promise<unknown>;
	deleteAllRules(target: DeviceTarget): Promise<void>;
}

/** Wall light-switch control. Protocol-identical to {@link PlugApi}; a thin alias for intent. */
export interface SwitchApi {
	on(target: DeviceTarget): Promise<void>;
	off(target: DeviceTarget): Promise<void>;
	setState(target: DeviceTarget, on: boolean): Promise<void>;
	getState(target: DeviceTarget): Promise<0 | 1>;
	toggle(target: DeviceTarget): Promise<0 | 1>;
}

/** Dimmer-switch brightness/ramp control (HS220, KS220, KS230). On/off is via {@link SwitchApi}. */
export interface DimmerApi {
	setBrightness(target: DeviceTarget, brightness: number): Promise<void>;
	setBrightnessTransition(target: DeviceTarget, brightness: number, durationMs: number, mode?: string): Promise<void>;
	getParameters(target: DeviceTarget): Promise<DimmerParameters>;
	setFadeOnTime(target: DeviceTarget, ms: number): Promise<void>;
	setFadeOffTime(target: DeviceTarget, ms: number): Promise<void>;
	setGentleOnTime(target: DeviceTarget, ms: number): Promise<void>;
	setGentleOffTime(target: DeviceTarget, ms: number): Promise<void>;
	setDoubleClickAction(target: DeviceTarget, mode: DimmerActionMode, brightness?: number): Promise<void>;
	setLongPressAction(target: DeviceTarget, mode: DimmerActionMode, brightness?: number): Promise<void>;
}

/** Motion (PIR) and ambient-light (LAS) sensor configuration on motion switches (KS200M, KS220M). */
export interface MotionApi {
	getPirConfig(target: DeviceTarget): Promise<PirConfig>;
	setPirEnabled(target: DeviceTarget, enabled: boolean): Promise<void>;
	setPirSensitivity(target: DeviceTarget, index: number): Promise<void>;
	setPirCooldown(target: DeviceTarget, ms: number): Promise<void>;
	getPirAdc(target: DeviceTarget): Promise<number>;
	getAmbientConfig(target: DeviceTarget): Promise<AmbientLightConfig>;
	setAmbientEnabled(target: DeviceTarget, enabled: boolean): Promise<void>;
	setDarkThreshold(target: DeviceTarget, index: number): Promise<void>;
}
