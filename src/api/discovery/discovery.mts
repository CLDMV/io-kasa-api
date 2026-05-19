/**
 * Kasa device discovery.
 *
 * Two strategies:
 *   - `discover()` — UDP broadcast. Fast, but local subnet only.
 *   - `sweep(cidr)` — unicast TCP `get_sysinfo` to every host in a CIDR. Each
 *     probe is a routed connection, so this works across subnets.
 *
 * Both never throw — they go through `self.events.runUntargeted` and resolve
 * to `[]` (and an `error` event) on failure. No `throw` keyword in this file;
 * internal validators return `Failure` sentinels or `null` instead.
 *
 * The UDP cipher comes from `self.protocol` — slothlet 3.6.0+ passes
 * `Buffer`s across the `self` boundary intact.
 *
 * Newer KLAP-only devices won't reply on port 9999 (port 20002, out of scope).
 */
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type {
	DiscoverOptions,
	DiscoveredDevice,
	Failure,
	ResolvedBroadcast,
	SelfApi,
	SweepOptions,
	SysInfo
} from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

const DEFAULT_PORT = 9999;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_SWEEP_TIMEOUT_MS = 1000;
const DEFAULT_SWEEP_CONCURRENCY = 64;
/** Refuse to sweep ranges larger than a /16 — bigger scans should be deliberate. */
const MAX_SWEEP_HOSTS = 65536;
const QUERY: Record<string, Record<string, unknown>> = { system: { get_sysinfo: {} } };

// --- Broadcast-address resolution ----------------------------------------------

/** Function shape compatible with {@link networkInterfaces}, used for test injection. */
export type GetInterfacesFn = () => ReturnType<typeof networkInterfaces>;

/** Parse an IPv4 address to a uint32 — returns `NaN` on malformed input (no throw). */
function ipToInt(ip: string): number {
	const parts = ip.split(".").map((p) => Number(p));
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return NaN;
	return (((parts[0] as number) << 24) | ((parts[1] as number) << 16) | ((parts[2] as number) << 8) | (parts[3] as number)) >>> 0;
}

function intToIp(n: number): string {
	return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

function netmaskFromPrefix(prefix: number): number {
	if (prefix <= 0) return 0;
	if (prefix >= 32) return 0xffffffff;
	return (0xffffffff << (32 - prefix)) >>> 0;
}

function broadcastFor(ip: string, prefix: number): string {
	const mask = netmaskFromPrefix(prefix);
	const network = ipToInt(ip) & mask;
	return intToIp((network | (~mask >>> 0)) >>> 0);
}

function isInSubnet(candidate: string, ip: string, prefix: number): boolean {
	const mask = netmaskFromPrefix(prefix);
	return (ipToInt(candidate) & mask) === (ipToInt(ip) & mask);
}

function listIPv4Interfaces(getInterfaces: GetInterfacesFn): Array<{
	name: string;
	info: NetworkInterfaceInfo & { cidr: string };
}> {
	const out: Array<{ name: string; info: NetworkInterfaceInfo & { cidr: string } }> = [];
	for (const [name, infos] of Object.entries(getInterfaces())) {
		if (!infos) continue;
		for (const info of infos) {
			if (info.family !== "IPv4") continue;
			if (info.internal) continue;
			// 169.254/16 is link-local (DHCP failed) — usually not what you want.
			if (info.address.startsWith("169.254.")) continue;
			if (!info.cidr) continue;
			out.push({ name, info: info as NetworkInterfaceInfo & { cidr: string } });
		}
	}
	return out;
}

/**
 * Sync resolver — returns `null` when no candidate interface exists (no throw).
 * Exported for tests; the public {@link resolveBroadcast} wraps this with the
 * event/no-throw machinery.
 */
export function resolveBroadcastSync(
	baseIp?: string,
	getInterfaces: GetInterfacesFn = networkInterfaces
): ResolvedBroadcast | null {
	const interfaces = listIPv4Interfaces(getInterfaces);

	if (baseIp) {
		for (const { name, info } of interfaces) {
			const prefix = Number(info.cidr.split("/")[1]);
			if (isInSubnet(baseIp, info.address, prefix)) {
				return {
					bindAddress: info.address,
					broadcast: broadcastFor(info.address, prefix),
					interface: name,
					cidr: prefix
				};
			}
		}
		// Fallback: caller gave us an IP we couldn't match. Treat it as a /24.
		return { bindAddress: baseIp, broadcast: broadcastFor(baseIp, 24), interface: "unknown", cidr: 24 };
	}

	const first = interfaces[0];
	if (!first) return null;
	const prefix = Number(first.info.cidr.split("/")[1]);
	return {
		bindAddress: first.info.address,
		broadcast: broadcastFor(first.info.address, prefix),
		interface: first.name,
		cidr: prefix
	};
}

// --- Discovery -----------------------------------------------------------------

/**
 * Resolve a broadcast address to use for UDP discovery. Never throws — resolves
 * to `null` (and emits an `error` event) when no usable interface exists.
 */
export async function resolveBroadcast(
	baseIp?: string,
	getInterfaces: GetInterfacesFn = networkInterfaces
): Promise<ResolvedBroadcast | null> {
	return self.events.runUntargeted(
		"discovery.resolveBroadcast",
		[baseIp],
		() => {
			const r = resolveBroadcastSync(baseIp, getInterfaces);
			return r ?? self.events.failure("No usable IPv4 interface found for Kasa discovery. Pass `baseIp` explicitly or specify `broadcast`.");
		},
		null
	);
}

/**
 * Discover Kasa devices on the local network.
 *
 * Returns whatever has responded by the time the listen window expires
 * (or `maxDevices` is reached). Duplicate responses from the same host
 * are deduplicated by `host:port`. Never throws — resolves to `[]` on
 * failure and emits an `error` event.
 */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
	return self.events.runUntargeted("discovery.discover", [options], () => discoverImpl(options), []);
}

async function discoverImpl(options: DiscoverOptions): Promise<DiscoveredDevice[]> {
	const port = options.port ?? DEFAULT_PORT;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxDevices = options.maxDevices ?? Infinity;

	let broadcast = options.broadcast;
	let bindAddress = options.bindAddress;
	if (!broadcast || !bindAddress) {
		const resolved = resolveBroadcastSync(options.baseIp);
		if (resolved) {
			broadcast ??= resolved.broadcast;
			bindAddress ??= resolved.bindAddress;
		} else {
			// Fall back to limited broadcast if interface auto-detect failed.
			if (process.env.KASA_DEBUG) console.warn(`[kasa] interface auto-detect failed; using 255.255.255.255`);
			broadcast ??= "255.255.255.255";
		}
	}

	const payload = self.protocol.encryptUdp(JSON.stringify(QUERY));
	const found = new Map<string, DiscoveredDevice>();

	return await new Promise<DiscoveredDevice[]>((resolve, reject) => {
		const socket = createSocket({ type: "udp4", reuseAddr: true });
		let settled = false;

		const finish = (err: Error | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.close();
			if (err) reject(err);
			else resolve(Array.from(found.values()));
		};

		socket.once("error", (err) => finish(err));
		socket.on("message", (msg, rinfo) => {
			try {
				const parsed = JSON.parse(self.protocol.decryptUdp(msg)) as { system?: { get_sysinfo?: SysInfo } };
				const sysInfo = parsed.system?.get_sysinfo;
				if (!sysInfo) return;
				const key = `${rinfo.address}:${rinfo.port}`;
				if (!found.has(key)) {
					found.set(key, { host: rinfo.address, port: rinfo.port, sysInfo });
					if (found.size >= maxDevices) finish(null);
				}
			} catch {
				// Ignore garbage from non-Kasa devices that happen to reply.
			}
		});

		socket.bind({ address: bindAddress, port: 0, exclusive: false }, () => {
			socket.setBroadcast(true);
			socket.send(payload, 0, payload.length, port, broadcast as string, (err) => {
				if (err) finish(err);
			});
		});

		const timer = setTimeout(() => finish(null), timeoutMs);
	});
}

// --- Unicast CIDR sweep --------------------------------------------------------

/** Parse a CIDR string into its network base (uint32) and prefix length. */
function parseCidr(cidr: string): { network: number; prefix: number } | Failure {
	const slash = cidr.indexOf("/");
	if (slash < 0) return self.events.failure(`Invalid CIDR (missing prefix): ${cidr}`);
	const ip = cidr.slice(0, slash);
	const prefix = Number(cidr.slice(slash + 1));
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return self.events.failure(`Invalid CIDR prefix: ${cidr}`);
	const network = ipToInt(ip);
	if (Number.isNaN(network)) return self.events.failure(`Invalid CIDR (not an IPv4): ${cidr}`);
	const mask = netmaskFromPrefix(prefix);
	return { network: (network & mask) >>> 0, prefix };
}

/** Expand a CIDR to the list of host addresses to probe (network/broadcast excluded for /≤30). */
function cidrHosts(cidr: string): string[] | Failure {
	const parsed = parseCidr(cidr);
	if (self.events.isFailure(parsed)) return parsed;
	const { network, prefix } = parsed;
	const total = 2 ** (32 - prefix);
	if (total > MAX_SWEEP_HOSTS) {
		return self.events.failure(`CIDR ${cidr} spans ${total} addresses; refusing to sweep more than ${MAX_SWEEP_HOSTS}.`);
	}
	const hosts: string[] = [];
	if (total <= 2) {
		// /31 and /32 — every address is usable.
		for (let i = 0; i < total; i++) hosts.push(intToIp((network + i) >>> 0));
	} else {
		// Skip the network address and the directed-broadcast address.
		for (let i = 1; i < total - 1; i++) hosts.push(intToIp((network + i) >>> 0));
	}
	return hosts;
}

/**
 * Sweep a CIDR range by unicast TCP `get_sysinfo` to every host.
 *
 * Works across subnets/VLANs because each probe is an ordinary routed TCP
 * connection rather than a broadcast. Hosts that don't answer (no device,
 * wrong port, timeout) are silently skipped. Never throws — resolves to `[]`
 * on a bad CIDR / oversized range and emits an `error` event.
 */
export async function sweep(cidr: string, options: SweepOptions = {}): Promise<DiscoveredDevice[]> {
	return self.events.runUntargeted("discovery.sweep", [cidr, options], () => sweepImpl(cidr, options), []);
}

async function sweepImpl(cidr: string, options: SweepOptions): Promise<DiscoveredDevice[] | Failure> {
	const port = options.port ?? DEFAULT_PORT;
	const timeoutMs = options.timeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_SWEEP_CONCURRENCY);

	const hosts = cidrHosts(cidr);
	if (self.events.isFailure(hosts)) return hosts;

	const found: DiscoveredDevice[] = [];
	let cursor = 0;

	const worker = async (): Promise<void> => {
		while (cursor < hosts.length) {
			const host = hosts[cursor++] as string;
			try {
				const response = await self.protocol.send({ host, port, timeoutMs }, QUERY);
				const sysInfo = (response as { system?: { get_sysinfo?: SysInfo } }).system?.get_sysinfo;
				if (sysInfo) found.push({ host, port, sysInfo });
			} catch {
				// Host absent, port closed, or not a Kasa device — skip.
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
	found.sort((a, b) => ipToInt(a.host) - ipToInt(b.host));
	return found;
}
