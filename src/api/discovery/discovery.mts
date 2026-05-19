/**
 * Kasa device discovery.
 *
 * Two strategies:
 *   - `discover()` — UDP broadcast. Fast, but local subnet only: broadcasts
 *     don't cross routers, so it can't see devices on another subnet/VLAN.
 *   - `sweep(cidr)` — unicast TCP `get_sysinfo` to every host in a CIDR. Each
 *     probe is a routed connection, so this works across subnets.
 *
 * Broadcast address resolution for `discover()` (in order of precedence):
 *   1. `options.broadcast` if explicitly given
 *   2. computed from `options.baseIp` (matched against this host's interfaces)
 *   3. computed from the host's first non-internal IPv4 interface
 *
 * The UDP cipher comes from `self.protocol` — slothlet 3.6.0+ no longer
 * proxy-wraps `Buffer`s crossing the `self` boundary, so the shared cipher
 * works directly. `sweep()` goes through `self.protocol.send`.
 *
 * Newer KLAP-only devices won't reply on port 9999 (they need port 20002,
 * out of scope here).
 */
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type {
	DiscoverOptions,
	DiscoveredDevice,
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

function ipToInt(ip: string): number {
	const parts = ip.split(".").map((p) => Number(p));
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
		throw new Error(`Not an IPv4 address: ${ip}`);
	}
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
 * Sync resolver — throws if no candidate interface exists. Exported for
 * tests that want to assert behaviour without the slothlet runtime; the
 * public {@link resolveBroadcast} wraps this in `runUntargeted` so callers
 * see a no-throw `ResolvedBroadcast | null` instead.
 */
export function resolveBroadcastSync(baseIp?: string, getInterfaces: GetInterfacesFn = networkInterfaces): ResolvedBroadcast {
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
	if (!first) {
		throw new Error("No usable IPv4 interface found for Kasa discovery. " + "Pass `baseIp` explicitly or specify `broadcast`.");
	}
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
 *
 * Precedence:
 *   1. `baseIp` supplied and matching an interface → that interface's directed broadcast.
 *   2. `baseIp` supplied but unmatched → accept it as a literal bind address, assume /24.
 *   3. No `baseIp` → first non-internal IPv4 interface and its directed broadcast.
 */
export async function resolveBroadcast(
	baseIp?: string,
	getInterfaces: GetInterfacesFn = networkInterfaces
): Promise<ResolvedBroadcast | null> {
	return self.events.runUntargeted(
		"discovery.resolveBroadcast",
		[baseIp],
		() => resolveBroadcastSync(baseIp, getInterfaces),
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
		try {
			const resolved = resolveBroadcastSync(options.baseIp);
			broadcast ??= resolved.broadcast;
			bindAddress ??= resolved.bindAddress;
		} catch (err) {
			// Fall back to limited broadcast if interface auto-detect failed.
			broadcast ??= "255.255.255.255";
			if (process.env.KASA_DEBUG) {
				console.warn(`[kasa] interface auto-detect failed: ${(err as Error).message}`);
			}
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
function parseCidr(cidr: string): { network: number; prefix: number } {
	const slash = cidr.indexOf("/");
	if (slash < 0) throw new Error(`Invalid CIDR (missing prefix): ${cidr}`);
	const ip = cidr.slice(0, slash);
	const prefix = Number(cidr.slice(slash + 1));
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
		throw new Error(`Invalid CIDR prefix: ${cidr}`);
	}
	const mask = netmaskFromPrefix(prefix);
	return { network: (ipToInt(ip) & mask) >>> 0, prefix };
}

/** Expand a CIDR to the list of host addresses to probe (network/broadcast excluded for /≤30). */
function cidrHosts(cidr: string): string[] {
	const { network, prefix } = parseCidr(cidr);
	const total = 2 ** (32 - prefix);
	if (total > MAX_SWEEP_HOSTS) {
		throw new Error(
			`CIDR ${cidr} spans ${total} addresses; refusing to sweep more than ${MAX_SWEEP_HOSTS}. Use a smaller range.`
		);
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
 * Unlike {@link discover}, this works across subnets/VLANs because each probe
 * is an ordinary routed TCP connection rather than a broadcast. Hosts that
 * don't answer (no device, wrong port, timeout) are silently skipped.
 *
 * Never throws — resolves to `[]` on a bad CIDR / oversized range and emits
 * an `error` event.
 *
 * @param cidr - Range to scan, e.g. `"10.8.1.0/24"`.
 */
export async function sweep(cidr: string, options: SweepOptions = {}): Promise<DiscoveredDevice[]> {
	return self.events.runUntargeted("discovery.sweep", [cidr, options], () => sweepImpl(cidr, options), []);
}

async function sweepImpl(cidr: string, options: SweepOptions): Promise<DiscoveredDevice[]> {
	const port = options.port ?? DEFAULT_PORT;
	const timeoutMs = options.timeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_SWEEP_CONCURRENCY);

	const hosts = cidrHosts(cidr);
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
