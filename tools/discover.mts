#!/usr/bin/env node
/**
 * Find Kasa devices and print the raw `DiscoveredDevice[]`.
 *
 * Two modes:
 *   - default: UDP broadcast — fast, but local subnet only.
 *   - `--sweep <cidr>`: unicast TCP scan of a CIDR — works across subnets/VLANs.
 *
 * Usage (CLI):
 *   npm run discover                                  # broadcast, auto-detect
 *   npm run discover -- 192.168.1.10                  # broadcast, positional baseIp
 *   npm run discover -- --broadcast 10.0.5.255 --bind 10.0.1.42
 *   npm run discover -- --sweep 10.8.1.0/24           # cross-subnet unicast scan
 *   npm run discover -- --sweep 10.8.1.0/24 --timeout 800 --concurrency 128
 *   npm run discover -- --port 9999 --timeout 5000 --max 3
 *
 * Usage (env vars — still supported):
 *   KASA_BASE_IP=192.168.1.10 npm run discover
 *   KASA_BROADCAST=10.0.5.255 KASA_BIND=10.0.1.42 npm run discover
 *   KASA_SWEEP=10.8.1.0/24 npm run discover
 *   KASA_TIMEOUT_MS=5000 KASA_PORT=9999 npm run discover
 */
import { createKasaApi } from "../src/index.mts";
import { resolveBroadcast } from "../src/api/discovery/discovery.mts";
import type { DiscoverOptions, SweepOptions } from "../src/lib/types.mts";

interface CliArgs {
  baseIp?: string;
  broadcast?: string;
  bindAddress?: string;
  sweep?: string;
  port?: number;
  timeoutMs?: number;
  maxDevices?: number;
  concurrency?: number;
  /** Substring filter against alias / IP / MAC (case-insensitive). */
  filter?: string;
  /** Print a compact `Name | IP | Model | MAC` table instead of full JSON. */
  min?: boolean;
  help?: boolean;
}

const USAGE = `Usage: npm run discover -- [baseIp] [--sweep CIDR] [options]

Modes:
  (default)        UDP broadcast — local subnet only.
  --sweep CIDR     Unicast TCP scan of CIDR (e.g. 10.8.1.0/24). Works across
                   subnets/VLANs; use this when devices are on another network.

Broadcast options:
  baseIp           Any IPv4 on the target subnet (positional). Picks the
                   matching local interface and its directed broadcast.
  --base-ip IP     Same as the positional argument.
  --broadcast IP   Force a specific broadcast destination.
  --bind IP        Force the local interface bind address.
  --max N          Stop after this many devices respond.

Shared options:
  --port N         TCP/UDP port. Default 9999.
  --timeout MS     Broadcast: listen window (default 3000).
                   Sweep: per-host probe timeout (default 1000).
  --concurrency N  Sweep only: parallel probes. Default 64.
  --filter TEXT    Keep only devices whose alias / IP / MAC contains TEXT
                   (case-insensitive substring; MAC is matched hex-only,
                   so "aabb" matches "aa:bb:..." or "aa-bb-...").
  --min            Print a compact 'Name | IP | Model | MAC' table to stdout
                   instead of the full DiscoveredDevice[] JSON.
  -h, --help       Show this help.

Env vars (CLI args override env):
  KASA_BASE_IP, KASA_BROADCAST, KASA_BIND, KASA_SWEEP, KASA_PORT,
  KASA_TIMEOUT_MS, KASA_MAX_DEVICES, KASA_CONCURRENCY`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    /** Consume and return the value that must follow a `--flag`. */
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) {
        console.error(`Missing value for ${a}\n\n${USAGE}`);
        process.exit(2);
      }
      return next;
    };
    if (a === "-h" || a === "--help") {
      args.help = true;
      continue;
    }
    if (a === "--base-ip" || a === "--baseip") {
      args.baseIp = value();
      continue;
    }
    if (a === "--broadcast") {
      args.broadcast = value();
      continue;
    }
    if (a === "--bind") {
      args.bindAddress = value();
      continue;
    }
    if (a === "--sweep" || a === "--cidr") {
      args.sweep = value();
      continue;
    }
    if (a === "--port") {
      args.port = Number(value());
      continue;
    }
    if (a === "--timeout" || a === "--timeout-ms") {
      args.timeoutMs = Number(value());
      continue;
    }
    if (a === "--max" || a === "--max-devices") {
      args.maxDevices = Number(value());
      continue;
    }
    if (a === "--concurrency") {
      args.concurrency = Number(value());
      continue;
    }
    if (a === "--filter") {
      args.filter = value();
      continue;
    }
    if (a === "--min") {
      args.min = true;
      continue;
    }
    // Bare positional (only one accepted) becomes baseIp.
    if (!a.startsWith("-") && args.baseIp === undefined) {
      args.baseIp = a;
      continue;
    }
    console.error(`Unknown argument: ${a}\n\n${USAGE}`);
    process.exit(2);
  }
  return args;
}

/** Hex-only lowercased MAC string — matches python-kasa's canonical form. */
function normMac(s: string | undefined): string {
  return (s ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/**
 * A filter string is "MAC-shaped" if every character is a hex digit or a
 * MAC-allowed separator (`:` / `-` / `.`). Words like `"stair"` aren't MAC-
 * shaped (the `s`, `t`, `i`, `r` aren't hex), so we skip the MAC check —
 * otherwise stripping non-hex would leave one stray `"a"` matching every
 * device's MAC.
 */
function isMacShaped(filter: string): boolean {
  return /^[0-9a-fA-F:\-.]+$/.test(filter);
}

/**
 * Substring match against alias / IP / MAC / child-outlet alias (case-
 * insensitive; MAC hex-only). For HS300 / KP200 strips the parent's auto-
 * generated alias is meaningless — we also look at each child's alias so
 * `--filter "Top Plug"` matches a strip whose outlets carry that name.
 */
function matchesFilter(device: { host: string; sysInfo: Record<string, unknown> }, filter: string): boolean {
  const needle = filter.toLowerCase();
  if (String(device.sysInfo.alias ?? "").toLowerCase().includes(needle)) return true;
  if (device.host.toLowerCase().includes(needle)) return true;
  const children = device.sysInfo.children as Array<{ alias?: string }> | undefined;
  if (Array.isArray(children) && children.some((c) => String(c.alias ?? "").toLowerCase().includes(needle))) {
    return true;
  }
  if (!isMacShaped(filter)) return false;
  // MAC-shaped — compare the hex-only form so callers don't have to match
  // separators. A short stripped needle (< 2 hex chars) is still likely too
  // promiscuous; require at least 2 hex chars before any MAC match counts.
  const hexNeedle = filter.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hexNeedle.length < 2) return false;
  const macHex = normMac(String(device.sysInfo.mac ?? device.sysInfo.mic_mac ?? ""));
  return macHex.includes(hexNeedle);
}

/**
 * Render a compact `Name | IP | Model | MAC` table (Markdown-style pipes).
 *
 * Devices with `children` (HS300 / KP200 multi-outlet plugs) are expanded
 * into one row per child outlet — the parent's auto-generated alias
 * (`TP-LINK_Smart Plug_57A5` etc.) is meaningless, the outlets are the
 * usable units. Each child row's `IP` column carries the canonical
 * `<ip>/<index>` key form the `api.aliases.apply` JSON map accepts.
 */
function renderMinTable(devices: Array<{ host: string; sysInfo: Record<string, unknown> }>): string {
  type Row = { name: string; ip: string; model: string; mac: string };
  const rows: Row[] = [];
  for (const d of devices) {
    const model = String(d.sysInfo.model ?? "");
    const mac = String(d.sysInfo.mac ?? d.sysInfo.mic_mac ?? "");
    const children = d.sysInfo.children as Array<{ id: string; alias: string }> | undefined;
    if (Array.isArray(children) && children.length > 0) {
      children.forEach((c, i) =>
        rows.push({
          name: String(c.alias ?? "(unnamed)"),
          ip: `${d.host}/${i}`,
          model,
          mac
        })
      );
    } else {
      rows.push({
        name: String(d.sysInfo.alias ?? "(unnamed)"),
        ip: d.host,
        model,
        mac
      });
    }
  }
  // Alphabetise by name so the same network always prints the same order.
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const header: Row = { name: "Name", ip: "IP", model: "Model", mac: "MAC" };
  const widths = {
    name: Math.max(header.name.length, ...rows.map((r) => r.name.length)),
    ip: Math.max(header.ip.length, ...rows.map((r) => r.ip.length)),
    model: Math.max(header.model.length, ...rows.map((r) => r.model.length)),
    mac: Math.max(header.mac.length, ...rows.map((r) => r.mac.length))
  };
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
  const line = (r: Row): string =>
    `${pad(r.name, widths.name)}  ${pad(r.ip, widths.ip)}  ${pad(r.model, widths.model)}  ${pad(r.mac, widths.mac)}`;
  const ruler = `${"-".repeat(widths.name)}  ${"-".repeat(widths.ip)}  ${"-".repeat(widths.model)}  ${"-".repeat(widths.mac)}`;
  return [line(header), ruler, ...rows.map(line)].join("\n");
}

const cli = parseArgs(process.argv.slice(2));

if (cli.help) {
  console.log(USAGE);
  process.exit(0);
}

const baseIp = cli.baseIp ?? process.env.KASA_BASE_IP;
const broadcast = cli.broadcast ?? process.env.KASA_BROADCAST;
const bindAddress = cli.bindAddress ?? process.env.KASA_BIND;
const sweepCidr = cli.sweep ?? process.env.KASA_SWEEP;
const port = cli.port ?? Number(process.env.KASA_PORT ?? "9999");
const concurrency = cli.concurrency ?? (process.env.KASA_CONCURRENCY ? Number(process.env.KASA_CONCURRENCY) : undefined);
const maxDevices = cli.maxDevices ?? (process.env.KASA_MAX_DEVICES ? Number(process.env.KASA_MAX_DEVICES) : undefined);
const explicitTimeout = cli.timeoutMs ?? (process.env.KASA_TIMEOUT_MS ? Number(process.env.KASA_TIMEOUT_MS) : undefined);

const api = await createKasaApi();
const started = Date.now();

if (sweepCidr) {
  // Unicast CIDR sweep — cross-subnet capable.
  const timeoutMs = explicitTimeout ?? 1000;
  const sweepOpts: SweepOptions = { port, timeoutMs };
  if (concurrency !== undefined) sweepOpts.concurrency = concurrency;
  console.error(
    `Sweeping ${sweepCidr} port=${port} timeoutMs=${timeoutMs} concurrency=${concurrency ?? 64}` +
      (cli.filter ? ` filter=${JSON.stringify(cli.filter)}` : "")
  );
  let devices = await api.discovery.sweep(sweepCidr, sweepOpts);
  if (cli.filter) devices = devices.filter((d) => matchesFilter(d, cli.filter as string));
  console.error(`Found ${devices.length} device(s) in ${Date.now() - started}ms.`);
  console.log(cli.min ? renderMinTable(devices) : JSON.stringify(devices, null, 2));
  process.exit(0);
}

// Broadcast discovery — local subnet.
const timeoutMs = explicitTimeout ?? 3000;
const opts: DiscoverOptions = { port, timeoutMs };
if (baseIp) opts.baseIp = baseIp;
if (broadcast) opts.broadcast = broadcast;
if (bindAddress) opts.bindAddress = bindAddress;
if (maxDevices !== undefined) opts.maxDevices = maxDevices;

const resolved = await resolveBroadcast(baseIp);
if (resolved) {
  console.error(
    `Using interface=${resolved.interface} bind=${bindAddress ?? resolved.bindAddress} ` +
      `broadcast=${broadcast ?? resolved.broadcast} port=${port} timeoutMs=${timeoutMs}` +
      (maxDevices !== undefined ? ` maxDevices=${maxDevices}` : "")
  );
} else {
  console.error(
    `Interface auto-detect failed; ` +
      `using bind=${bindAddress ?? "<os pick>"} broadcast=${broadcast ?? "255.255.255.255"} ` +
      `port=${port} timeoutMs=${timeoutMs}`
  );
}

let devices = await api.discovery.discover(opts);
if (cli.filter) devices = devices.filter((d) => matchesFilter(d, cli.filter as string));
console.error(`Found ${devices.length} device(s) in ${Date.now() - started}ms.`);
console.log(cli.min ? renderMinTable(devices) : JSON.stringify(devices, null, 2));

process.exit(0);
