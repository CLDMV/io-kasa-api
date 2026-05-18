/**
 * Kasa device discovery via UDP broadcast.
 *
 * Sends an encrypted `system.get_sysinfo` to the subnet's directed broadcast
 * on port 9999 and collects responding devices until either `timeoutMs`
 * elapses or `maxDevices` reply.
 *
 * Broadcast address resolution (in order of precedence):
 *   1. `options.broadcast` if explicitly given
 *   2. computed from `options.baseIp` (matched against this host's interfaces)
 *   3. computed from the host's first non-internal IPv4 interface
 *
 * Self-contained on purpose — see the note in `protocol/protocol.mts`.
 * Newer KLAP-only devices won't reply on port 9999 (they need port 20002,
 * out of scope here).
 */
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import type { DiscoverOptions, DiscoveredDevice, ResolvedBroadcast, SysInfo } from "../../lib/types.mts";

const DEFAULT_PORT = 9999;
const DEFAULT_TIMEOUT_MS = 3000;
const XOR_SEED = 0xab;
const QUERY: Record<string, Record<string, unknown>> = { system: { get_sysinfo: {} } };

// --- UDP autokey cipher (inlined; identical to protocol/protocol.mts) ----------

function encryptUdp(data: string): Buffer {
	const payload = Buffer.from(data, "utf8");
	const out = Buffer.alloc(payload.length);
	let key = XOR_SEED;
	for (let i = 0; i < payload.length; i++) {
		const c = key ^ (payload[i] as number);
		out[i] = c;
		key = c;
	}
	return out;
}

function decryptUdp(payload: Buffer): string {
	const out = Buffer.alloc(payload.length);
	let key = XOR_SEED;
	for (let i = 0; i < payload.length; i++) {
		const c = payload[i] as number;
		out[i] = key ^ c;
		key = c;
	}
	return out.toString("utf8");
}

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
 * Resolve a broadcast address to use for UDP discovery.
 *
 * Precedence:
 *   1. `baseIp` supplied and matching an interface → that interface's directed broadcast.
 *   2. `baseIp` supplied but unmatched → accept it as a literal bind address, assume /24.
 *   3. No `baseIp` → first non-internal IPv4 interface and its directed broadcast.
 *
 * Throws if no candidate is available (host has only loopback).
 */
export function resolveBroadcast(baseIp?: string, getInterfaces: GetInterfacesFn = networkInterfaces): ResolvedBroadcast {
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
 * Discover Kasa devices on the local network.
 *
 * Returns whatever has responded by the time the listen window expires
 * (or `maxDevices` is reached). Duplicate responses from the same host
 * are deduplicated by `host:port`.
 */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
	const port = options.port ?? DEFAULT_PORT;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxDevices = options.maxDevices ?? Infinity;

	let broadcast = options.broadcast;
	let bindAddress = options.bindAddress;
	if (!broadcast || !bindAddress) {
		try {
			const resolved = resolveBroadcast(options.baseIp);
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

	const payload = encryptUdp(JSON.stringify(QUERY));
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
				const parsed = JSON.parse(decryptUdp(msg)) as { system?: { get_sysinfo?: SysInfo } };
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
