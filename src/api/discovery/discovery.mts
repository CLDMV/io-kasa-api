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
 * Newer KLAP-only devices won't reply on port 9999 — those need port 20002,
 * which is out of scope here.
 */
import { createSocket } from "node:dgram";
import { encryptUdp, decryptUdp } from "../../lib/cipher.mjs";
import { resolveBroadcast } from "../../lib/network.mjs";
import type {
  DiscoverOptions,
  DiscoveredDevice,
  SysInfo
} from "../../lib/types.mts";

const DEFAULT_PORT = 9999;
const DEFAULT_TIMEOUT_MS = 3000;
const QUERY: Record<string, Record<string, unknown>> = { system: { get_sysinfo: {} } };

export async function discover(options: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
  const port = options.port ?? DEFAULT_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDevices = options.maxDevices ?? Infinity;

  // If the caller fully overrides both, skip interface inspection entirely.
  let broadcast = options.broadcast;
  let bindAddress = options.bindAddress;
  if (!broadcast || !bindAddress) {
    try {
      const resolved = resolveBroadcast(options.baseIp);
      broadcast ??= resolved.broadcast;
      bindAddress ??= resolved.bindAddress;
    } catch (err) {
      // Fall back to limited broadcast if we couldn't auto-detect.
      broadcast ??= "255.255.255.255";
      // bindAddress stays undefined → OS picks the interface.
      if (process.env.KASA_DEBUG) console.warn(`[kasa] interface auto-detect failed: ${(err as Error).message}`);
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
        const decoded = decryptUdp(msg);
        const parsed = JSON.parse(decoded) as { system?: { get_sysinfo?: SysInfo } };
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
