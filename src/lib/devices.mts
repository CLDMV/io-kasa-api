/**
 * Device resolver + discovery cache.
 *
 * Resolves a device reference — an IP, a MAC, an alias (name), or an explicit
 * `DeviceTarget` — to a `DeviceTarget`. The underlying CIDR sweep is run once
 * and cached, so a long-running app can resolve repeatedly without re-scanning
 * the network on every command. `refresh()` re-scans on demand.
 *
 * Imported by `index.mts` (the entry), not loaded by slothlet.
 */
import type { DeviceRef, DeviceTarget, DevicesApi, DevicesScanOptions, DiscoveredDevice } from "./types.mts";

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
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Hex-only, lowercased — compares MACs regardless of separators or case. */
function normMac(s: string): string {
	return s.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

function isIpv4(s: string): boolean {
	const m = IPV4.exec(s);
	return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
}

/** A 12-hex-digit string (any separators) — i.e. a MAC. */
function isMac(s: string): boolean {
	return normMac(s).length === 12;
}

/**
 * Build the `api.devices` resolver/cache from the live API object.
 *
 * @param api - The built API (needs `discovery.sweep`).
 * @param defaultCidr - CIDR swept when a scan is needed and none is specified.
 */
export function buildDevices(api: AnyApi, defaultCidr: string = DEFAULT_CIDR): DevicesApi {
	let cache: DiscoveredDevice[] | null = null;
	/** In-flight first sweep, so concurrent cold calls don't each scan. */
	let inflight: Promise<DiscoveredDevice[]> | null = null;
	/** Options of the most recent sweep — reused for the on-miss retry. */
	let lastScan: DevicesScanOptions = {};

	async function sweep(options: DevicesScanOptions): Promise<DiscoveredDevice[]> {
		lastScan = options;
		const { cidr = defaultCidr, ...sweepOptions } = options;
		cache = await api.discovery.sweep(cidr, { ...SWEEP_DEFAULTS, ...sweepOptions });
		return cache;
	}

	/** Cached device list — sweeps once on first use. */
	async function list(options: DevicesScanOptions = {}): Promise<DiscoveredDevice[]> {
		if (cache !== null) return cache;
		if (!inflight) inflight = sweep(options).finally(() => (inflight = null));
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

	/**
	 * Find the full DiscoveredDevice for a ref. On a cache miss it re-sweeps
	 * once — so a newly-added device, or one a congested network dropped from
	 * the previous probe, still resolves without the caller knowing.
	 */
	async function find(ref: DeviceRef): Promise<DiscoveredDevice | undefined> {
		const hit = lookup(await list(), ref);
		if (hit) return hit;
		return lookup(await sweep(lastScan), ref);
	}

	return {
		list,
		find,
		refresh: (options: DevicesScanOptions = {}) => sweep(options),
		async resolve(ref: DeviceRef): Promise<DeviceTarget> {
			// An explicit target passes straight through (keeps port / timeoutMs).
			if (typeof ref !== "string") return ref;
			// A bare IP needs no lookup.
			if (isIpv4(ref)) return { host: ref };
			const device = await find(ref);
			if (!device) {
				throw new Error(
					`No Kasa device matching "${ref}" — not found on the network (swept twice). ` +
						`It may be offline, on another subnet, or not speak the legacy port-9999 protocol.`
				);
			}
			return { host: device.host };
		}
	};
}
