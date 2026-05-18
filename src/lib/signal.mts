/**
 * Network-health reporting — RSSI of devices, sorted best→worst.
 *
 * Built on the dynamic bulk layer: it resolves a device list (a CIDR sweep, an
 * explicit list, or a local broadcast), bulk-reads `get_sysinfo`, and projects
 * each to an RSSI entry. Non-responders appear with `reachable: false` so weak
 * or offline devices are visible.
 *
 * Imported by `index.mts` (the entry), not loaded by slothlet.
 */
import type {
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
	bulk: { device: { info: { get(targets: DeviceTarget[]): Promise<Array<OpResult<SysInfo>>> } } };
};

/**
 * Build the `api.signal` surface from the live API object.
 *
 * @param api - The built API (needs `discovery` and `bulk.device.getSysInfo`).
 */
export function buildSignal(api: AnyApi): SignalApi {
	return {
		async report(options: SignalReportOptions = {}): Promise<SignalEntry[]> {
			const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
			const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

			// Resolve the device list: explicit > CIDR sweep > local broadcast.
			let targets: DeviceTarget[];
			if (options.devices) {
				targets = options.devices;
			} else if (options.cidr) {
				const found = await api.discovery.sweep(options.cidr, { timeoutMs, concurrency });
				targets = found.map((d) => ({ host: d.host }));
			} else {
				const found = await api.discovery.discover({ timeoutMs });
				targets = found.map((d) => ({ host: d.host }));
			}

			// Bulk-read sysinfo (per-device timeout pinned).
			const probed = targets.map((t) => ({ ...t, timeoutMs }));
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
