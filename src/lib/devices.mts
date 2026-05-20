/**
 * Device resolver + discovery cache.
 *
 * Resolves a device reference — an IP, a MAC, an alias (name), or an explicit
 * `DeviceTarget` — to a `DeviceTarget`. The underlying CIDR sweep is run once
 * and cached, so a long-running app can resolve repeatedly without re-scanning
 * the network on every command. `refresh()` re-scans on demand.
 *
 * Every method goes through `api.events.runUntargeted` — they never throw, and
 * each emits a `devices.<method>` event on the bus (plus the catch-all tiers).
 * Passthrough / IP cases of `resolve` are silent (no event, no work). On a
 * cache miss `find`/`resolve` re-sweep once before giving up.
 *
 * Imported by `index.mts` (the entry), not loaded by slothlet.
 */
import type { DeviceRef, DeviceTarget, DevicesApi, DevicesScanOptions, DiscoveredDevice, EventsApi } from "./types.mts";

/** Network this project's devices live on — used when no `sweepCidr` is given. */
const DEFAULT_CIDR = "10.8.0.0/23";

/**
 * Sweep defaults for the resolver — more generous than `discovery.sweep`'s
 * bare defaults so a slow/congested network doesn't drop a device from a
 * 1 s probe window. Any explicit option still overrides these.
 */
const SWEEP_DEFAULTS = { timeoutMs: 1500, concurrency: 128 };

type AnyApi = {
	discovery: { sweep(cidr: string, options?: Record<string, unknown>): Promise<DiscoveredDevice[]> };
	events: EventsApi;
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Hex-only, lowercased — compares MACs regardless of separators or case. */
function normMac(s: string): string {
	return s.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/** A dotted-quad IPv4 string (every octet ≤ 255). */
export function isIpv4(s: string): boolean {
	const m = IPV4.exec(s);
	return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
}

/** A 12-hex-digit string (any separators) — i.e. a MAC. */
export function isMac(s: string): boolean {
	return normMac(s).length === 12;
}

/**
 * Built {@link DevicesApi} plus internal handles the ref-resolution wrapper
 * needs (sync passthrough/cache-lookup, no events).
 */
export type DevicesApiInternal = DevicesApi & {
	/**
	 * Sync passthrough/cache-lookup for the ref-resolution wrapper. Returns a
	 * target without touching the network or emitting events:
	 *
	 *   - `DeviceTarget` → the same object (passthrough)
	 *   - IPv4 string    → `{ host: ref }`
	 *   - cached MAC/name → `{ host: cached.host }`
	 *   - otherwise → `undefined` (caller must `await resolve(ref)` for the work)
	 */
	quickResolve(ref: DeviceRef): DeviceTarget | undefined;
};

/**
 * Build the `api.devices` resolver/cache from the live API object.
 *
 * @param api - The built API (needs `discovery.sweep` and `events.runUntargeted`).
 * @param defaultCidr - CIDR swept when a scan is needed and none is specified.
 */
export function buildDevices(api: AnyApi, defaultCidr: string = DEFAULT_CIDR): DevicesApiInternal {
	let cache: DiscoveredDevice[] | null = null;
	/** In-flight first sweep, so concurrent cold calls don't each scan. */
	let inflight: Promise<DiscoveredDevice[]> | null = null;
	/** Options of the most recent sweep — reused for the on-miss retry. */
	let lastScan: DevicesScanOptions = {};

	/** Private: actual sweep + cache write. No event (the caller emits). */
	async function sweepInternal(options: DevicesScanOptions): Promise<DiscoveredDevice[]> {
		lastScan = options;
		const { cidr = defaultCidr, ...sweepOptions } = options;
		cache = await api.discovery.sweep(cidr, { ...SWEEP_DEFAULTS, ...sweepOptions });
		return cache;
	}

	/** Private: cached list with first-call sweep. */
	async function listInternal(options: DevicesScanOptions): Promise<DiscoveredDevice[]> {
		if (cache !== null) return cache;
		if (!inflight) inflight = sweepInternal(options).finally(() => (inflight = null));
		return inflight;
	}

	/** Match a ref against a device list — by host (target/IP), MAC, or alias. */
	function lookup(devices: DiscoveredDevice[], ref: DeviceRef): DiscoveredDevice | undefined {
		if (typeof ref !== "string") return devices.find((d) => d.host === ref.host);
		if (isIpv4(ref)) return devices.find((d) => d.host === ref);
		if (isMac(ref)) {
			const want = normMac(ref);
			return devices.find((d) => normMac(String(d.sysInfo.mac ?? d.sysInfo.mic_mac ?? "")) === want);
		}
		const want = ref.trim().toLowerCase();
		return devices.find((d) => String(d.sysInfo.alias ?? "").trim().toLowerCase() === want);
	}

	/** Private: find with one auto re-sweep on a cache miss. */
	async function findInternal(ref: DeviceRef): Promise<DiscoveredDevice | undefined> {
		const hit = lookup(await listInternal({}), ref);
		if (hit) return hit;
		return lookup(await sweepInternal(lastScan), ref);
	}

	/** Sync passthrough/cache-lookup — see {@link DevicesApiInternal.quickResolve}. */
	function quickResolve(ref: DeviceRef): DeviceTarget | undefined {
		if (typeof ref !== "string") return ref;
		if (isIpv4(ref)) return { host: ref };
		if (cache === null) return undefined;
		const hit = lookup(cache, ref);
		return hit ? { host: hit.host } : undefined;
	}

	return {
		list: (options: DevicesScanOptions = {}) =>
			api.events.runUntargeted("devices.list", [options], () => listInternal(options), [] as DiscoveredDevice[]),
		refresh: (options: DevicesScanOptions = {}) =>
			api.events.runUntargeted("devices.refresh", [options], () => sweepInternal(options), [] as DiscoveredDevice[]),
		find: (ref: DeviceRef) =>
			api.events.runUntargeted<DiscoveredDevice | undefined>("devices.find", [ref], () => findInternal(ref), undefined),
		resolve: async (ref: DeviceRef, options?: { force?: boolean }) => {
			// Passthrough — no event, no work.
			if (typeof ref !== "string") return ref;
			// Bare IP — no event, no work.
			if (isIpv4(ref)) return { host: ref };
			// MAC / alias — lookup against the cache (force re-sweeps first).
			return api.events.runUntargeted<DeviceTarget | null>(
				"devices.resolve",
				options?.force ? [ref, { force: true }] : [ref],
				async () => {
					if (options?.force) {
						// Throw away the cache and re-scan before the lookup.
						await sweepInternal(lastScan);
					}
					const device = await findInternal(ref);
					return device ? { host: device.host } : null;
				},
				null
			);
		},
		quickResolve
	};
}
