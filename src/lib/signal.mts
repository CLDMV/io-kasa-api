/**
 * Network-health reporting — RSSI of devices, sorted best→worst.
 *
 * Built on the dynamic bulk layer: it resolves a device list (a CIDR sweep, an
 * explicit list, or a local broadcast), bulk-reads `get_sysinfo`, and projects
 * each to an RSSI entry. Non-responders appear with `reachable: false` so weak
 * or offline devices are visible.
 *
 * `report` accepts a few input shapes:
 *
 *   - omitted — UDP discover on the local subnet
 *   - a CIDR string (has `/`) — sweep that CIDR
 *   - an IPv4 / MAC / alias string — single-device report
 *   - a {@link SignalReportOptions} object — full control (`cidr`, `devices`,
 *     `concurrency`, `timeoutMs`)
 *
 * Imported by `index.mts` (the entry), not loaded by slothlet.
 */
import { isIpv4 } from "./devices.mts";
import type {
	DeviceRef,
	DeviceTarget,
	DiscoveredDevice,
	OpResult,
	SignalApi,
	SignalEntry,
	SignalReportOptions,
	SysInfo
} from "./types.mts";

const DEFAULT_CONCURRENCY = 32;
const DEFAULT_TIMEOUT_MS = 1500;

/** Bucket an RSSI (dBm) into a quality band. */
function quality(rssi: number): SignalEntry["quality"] {
	if (rssi >= -50) return "excellent";
	if (rssi >= -60) return "good";
	if (rssi >= -70) return "fair";
	return "weak";
}

type AnyApi = {
	discovery: {
		discover(options?: Record<string, unknown>): Promise<DiscoveredDevice[]>;
		sweep(cidr: string, options?: Record<string, unknown>): Promise<DiscoveredDevice[]>;
	};
	bulk: { device: { info: { get(refs: ReadonlyArray<DeviceRef>): Promise<Array<OpResult<SysInfo>>> } } };
};

/** Coerce the first arg of `report` to a {@link SignalReportOptions}. */
function normalizeInput(input?: string | SignalReportOptions): SignalReportOptions {
	if (input === undefined) return {};
	if (typeof input !== "string") return input;
	// A CIDR has a `/`; everything else is a single-device ref (IP/MAC/alias).
	if (input.includes("/")) return { cidr: input };
	return { devices: [input] };
}

/**
 * Build the `api.signal` surface from the live API object.
 *
 * @param api - The built API (needs `discovery` and `bulk.device.info.get`).
 */
export function buildSignal(api: AnyApi): SignalApi {
	return {
		async report(input?: string | SignalReportOptions): Promise<SignalEntry[]> {
			const options = normalizeInput(input);
			const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
			const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

			// Resolve the device list: explicit > CIDR sweep > local broadcast.
			let refs: ReadonlyArray<DeviceRef>;
			if (options.devices) {
				refs = options.devices;
			} else if (options.cidr) {
				const found = await api.discovery.sweep(options.cidr, { timeoutMs, concurrency });
				refs = found.map((d) => ({ host: d.host }));
			} else {
				const found = await api.discovery.discover({ timeoutMs });
				refs = found.map((d) => ({ host: d.host }));
			}

			// Bulk-read sysinfo (per-device timeout pinned). For object refs we
			// can pin the timeout; for string refs the bulk wrapper resolves them.
			const probed: DeviceRef[] = refs.map((r) =>
				typeof r === "string" ? r : ({ ...r, timeoutMs } as DeviceTarget)
			);
			const results = await api.bulk.device.info.get(probed);

			const entries: SignalEntry[] = results.map((r) => {
				const info = r.value ?? {};
				const rssi = typeof info.rssi === "number" ? info.rssi : null;
				return {
					host: r.host,
					alias: String(info.alias ?? ""),
					model: String(info.model ?? ""),
					rssi,
					quality: rssi === null ? "unknown" : quality(rssi),
					reachable: r.ok && r.reachable
				};
			});

			// Strongest first (RSSI nearest 0); unreachable devices sink to the bottom.
			entries.sort((a, b) => {
				if (a.rssi === null && b.rssi === null) return a.host.localeCompare(b.host);
				if (a.rssi === null) return 1;
				if (b.rssi === null) return -1;
				return b.rssi - a.rssi;
			});
			return entries;
		}
	};
}

// Re-export for symmetry — callers shouldn't need it, but signal-adjacent code might.
export { isIpv4 };
