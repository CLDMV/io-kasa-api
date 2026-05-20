/**
 * Device resolver + discovery cache.
 *
 * Resolves a device reference — an IP, a MAC, an alias (name), or an explicit
 * `DeviceTarget` — to a `DeviceTarget`. The underlying CIDR sweep is run once
 * and cached, so a long-running app can resolve repeatedly without re-scanning
 * the network on every command. `refresh()` re-scans on demand.
 *
 * Multi-outlet plug support: a ref can address a specific child outlet of a
 * strip (HS300 / KP200) in three ways:
 *
 *   - `"10.8.1.50/0"`            — host + numeric child index
 *   - `"10.8.1.50/<long-hex>"`   — host + full child ID
 *   - `"Cario Cabinet"`          — a child alias (the resolver walks every
 *                                  device's `sysInfo.children[].alias` when
 *                                  no device-level alias matches)
 *
 * Resolved child refs come back as a `DeviceTarget` with `host` and `child` set;
 * relay-controlling commands honour `target.child` automatically.
 *
 * Every method goes through `api.events.runUntargeted` — they never throw, and
 * each emits a `devices.<method>` event on the bus (plus the catch-all tiers).
 * Passthrough / IP cases of `resolve` are silent (no event, no work). When a
 * child alias is ambiguous (two devices have outlets with the same name), the
 * first match wins and a `devices.resolve` warning event fires noting the
 * duplicate count.
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

type ChildHit = { device: DiscoveredDevice; child: { id: string; alias: string; state: 0 | 1 } };

/** Find a child outlet on `device` by numeric index or full child ID. */
function findChildOnDevice(device: DiscoveredDevice, ref: string): ChildHit["child"] | undefined {
	const kids = device.sysInfo.children as Array<{ id: string; alias: string; state: 0 | 1 }> | undefined;
	if (!kids || kids.length === 0) return undefined;
	if (/^\d+$/.test(ref)) return kids[Number(ref)];
	const want = ref.toLowerCase();
	return kids.find((c) => c.id.toLowerCase() === want);
}

/**
 * Walk every device's children[] and return all (device, child) pairs whose
 * child alias matches `ref` (case- and whitespace-insensitive). The caller
 * picks the first; the count is used to warn on duplicates.
 */
function findChildrenByAlias(devices: DiscoveredDevice[], ref: string): ChildHit[] {
	const want = ref.trim().toLowerCase();
	const hits: ChildHit[] = [];
	for (const device of devices) {
		const kids = device.sysInfo.children as Array<{ id: string; alias: string; state: 0 | 1 }> | undefined;
		if (!kids) continue;
		for (const child of kids) {
			if (String(child.alias ?? "").trim().toLowerCase() === want) hits.push({ device, child });
		}
	}
	return hits;
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
	 *   - `host/<n>` or `host/<childId>` → `{ host, child: <resolved id> }` if
	 *                                       the host's cached sysinfo has children
	 *   - cached MAC / device alias → `{ host: cached.host }`
	 *   - cached child alias → `{ host: parent.host, child: <id> }`
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

	/**
	 * Match a ref against a device list — by host (target/IP), MAC, device
	 * alias, or — as a fallback for unmatched name strings — child alias.
	 * Returns either a bare device (parent-level match) or a (device, child)
	 * pair (child-level match).
	 */
	function lookup(
		devices: DiscoveredDevice[],
		ref: DeviceRef
	): { device: DiscoveredDevice; child?: ChildHit["child"]; duplicateCount?: number } | undefined {
		if (typeof ref !== "string") {
			const d = devices.find((x) => x.host === ref.host);
			return d ? { device: d } : undefined;
		}
		if (isIpv4(ref)) {
			const d = devices.find((x) => x.host === ref);
			return d ? { device: d } : undefined;
		}
		if (isMac(ref)) {
			const want = normMac(ref);
			const d = devices.find((x) => normMac(String(x.sysInfo.mac ?? x.sysInfo.mic_mac ?? "")) === want);
			return d ? { device: d } : undefined;
		}
		// Device-level alias first.
		const wantName = ref.trim().toLowerCase();
		const deviceMatch = devices.find((d) => String(d.sysInfo.alias ?? "").trim().toLowerCase() === wantName);
		if (deviceMatch) return { device: deviceMatch };
		// Fall back to child aliases — strips' outlets are what users actually
		// reference, not the parent's auto-generated `TP-LINK_Smart Plug_*` name.
		const childHits = findChildrenByAlias(devices, ref);
		if (childHits.length === 0) return undefined;
		const first = childHits[0] as ChildHit;
		return { device: first.device, child: first.child, duplicateCount: childHits.length };
	}

	/** Private: find with one auto re-sweep on a cache miss. */
	async function findInternal(ref: DeviceRef): Promise<DiscoveredDevice | undefined> {
		const hit = lookup(await listInternal({}), ref);
		if (hit) return hit.device;
		const retry = lookup(await sweepInternal(lastScan), ref);
		return retry?.device;
	}

	/**
	 * Internal: parse `host/<right>` syntax. If `right` is a numeric index or a
	 * hex string and the host's cached sysinfo has matching children, returns
	 * the resolved `{ host, child }` target. Otherwise returns `undefined`.
	 *
	 * Only consulted by `quickResolve` and `resolve` — the `/` is unambiguous
	 * because IPs (dots) and MACs (hex + `:` / `-`) never contain one.
	 */
	/** Build a DeviceTarget from a discovered device, preserving non-default port. */
	function targetFrom(device: DiscoveredDevice, child?: string): DeviceTarget {
		const out: DeviceTarget = { host: device.host };
		// Real Kasa is always 9999, but discovery records the actual port so
		// non-standard setups (and test fixtures using random ports) work too.
		if (typeof device.port === "number") out.port = device.port;
		if (child) out.child = child;
		return out;
	}

	function resolveChildSegment(ref: string): DeviceTarget | undefined {
		const slash = ref.indexOf("/");
		if (slash < 0) return undefined;
		const host = ref.slice(0, slash);
		const childRef = ref.slice(slash + 1);
		if (cache === null) return undefined;
		// Find the parent device by IP or MAC.
		let parent: DiscoveredDevice | undefined;
		if (isIpv4(host)) parent = cache.find((d) => d.host === host);
		else if (isMac(host)) {
			const want = normMac(host);
			parent = cache.find((d) => normMac(String(d.sysInfo.mac ?? d.sysInfo.mic_mac ?? "")) === want);
		}
		if (!parent) return undefined;
		const child = findChildOnDevice(parent, childRef);
		if (!child) return undefined;
		return targetFrom(parent, child.id);
	}

	/** Sync passthrough/cache-lookup — see {@link DevicesApiInternal.quickResolve}. */
	function quickResolve(ref: DeviceRef): DeviceTarget | undefined {
		if (typeof ref !== "string") return ref;
		if (isIpv4(ref)) return { host: ref };
		// `host/<right>` — child segment, needs the cache.
		if (ref.includes("/")) return resolveChildSegment(ref);
		if (cache === null) return undefined;
		const hit = lookup(cache, ref);
		if (!hit) return undefined;
		return targetFrom(hit.device, hit.child?.id);
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
			// Child segment (`host/<n>`) — needs the cache to find the child ID;
			// if the cache has the parent, resolve synchronously without an event.
			if (ref.includes("/") && cache !== null) {
				const synth = resolveChildSegment(ref);
				if (synth) return synth;
			}
			// MAC / device-or-child alias / unresolved child segment — full lookup.
			return api.events.runUntargeted<DeviceTarget | null>(
				"devices.resolve",
				options?.force ? [ref, { force: true }] : [ref],
				async () => {
					if (options?.force) await sweepInternal(lastScan);
					const devices = await listInternal({});
					let hit = lookup(devices, ref);
					if (!hit) {
						// Re-sweep once on cache miss (covers a newly-added device).
						const fresh = await sweepInternal(lastScan);
						hit = lookup(fresh, ref);
					}
					if (!hit) {
						// Child segment that needed a re-sweep? Re-try resolveChildSegment.
						if (ref.includes("/")) {
							const synth = resolveChildSegment(ref);
							if (synth) return synth;
						}
						return null;
					}
					// First-match-wins on duplicate child aliases; the warning
					// rides on the same `devices.resolve` event via the return value
					// — note it in the event payload by setting a sentinel field.
					// (The caller can also check `find()`/`list()` directly.)
					if (hit.duplicateCount && hit.duplicateCount > 1) {
						api.events.emitOp({
							ok: true,
							op: "devices.resolve",
							module: "devices",
							method: "resolve",
							args: [ref],
							durationMs: 0,
							at: Date.now(),
							value: {
								warning: "duplicate-child-alias",
								matches: hit.duplicateCount,
								picked: { host: hit.device.host, child: hit.child?.id }
							}
						});
					}
					return targetFrom(hit.device, hit.child?.id);
				},
				null
			);
		},
		quickResolve
	};
}
