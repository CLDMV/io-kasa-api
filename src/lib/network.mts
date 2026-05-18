/**
 * Network helpers for Kasa UDP discovery.
 *
 * Auto-detects a usable broadcast address from the host's interfaces so callers
 * don't have to hand-pick subnets. Lives in `src/lib/` (not `src/api/`) so it
 * isn't exposed as a slothlet endpoint.
 */
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";

export interface ResolvedBroadcast {
  /** Local interface IPv4 we'll bind to. */
  bindAddress: string;
  /** Directed broadcast address for that interface's subnet. */
  broadcast: string;
  /** Interface name (eth0, en0, etc). Informational. */
  interface: string;
  /** CIDR prefix length. Informational. */
  cidr: number;
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Not an IPv4 address: ${ip}`);
  }
  // >>> 0 to keep the result unsigned.
  return ((parts[0] as number) << 24 | (parts[1] as number) << 16 | (parts[2] as number) << 8 | (parts[3] as number)) >>> 0;
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

/** Function shape compatible with {@link networkInterfaces}, used for test injection. */
export type GetInterfacesFn = () => ReturnType<typeof networkInterfaces>;

/** Enumerate non-internal, non-link-local IPv4 interfaces with their CIDRs. */
function listIPv4Interfaces(getInterfaces: GetInterfacesFn): Array<{
  name: string;
  info: NetworkInterfaceInfo & { cidr: string };
}> {
  const out: Array<{ name: string; info: NetworkInterfaceInfo & { cidr: string } }> = [];
  const all = getInterfaces();
  for (const [name, infos] of Object.entries(all)) {
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
 *   1. If `baseIp` is supplied and matches an interface, use that interface's directed broadcast.
 *   2. If `baseIp` is supplied but doesn't match any interface, accept it as a literal bind address
 *      and assume a /24 (the common case for home LANs).
 *   3. Otherwise pick the first non-internal IPv4 interface and use its directed broadcast.
 *
 * Throws if no candidate is available (e.g. host has only loopback).
 */
export function resolveBroadcast(
  baseIp?: string,
  getInterfaces: GetInterfacesFn = networkInterfaces
): ResolvedBroadcast {
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
    return {
      bindAddress: baseIp,
      broadcast: broadcastFor(baseIp, 24),
      interface: "unknown",
      cidr: 24
    };
  }

  const first = interfaces[0];
  if (!first) {
    throw new Error(
      "No usable IPv4 interface found for Kasa discovery. " +
        "Pass `baseIp` explicitly or specify `broadcast`."
    );
  }
  const prefix = Number(first.info.cidr.split("/")[1]);
  return {
    bindAddress: first.info.address,
    broadcast: broadcastFor(first.info.address, prefix),
    interface: first.name,
    cidr: prefix
  };
}
