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
    `Sweeping ${sweepCidr} port=${port} timeoutMs=${timeoutMs} concurrency=${concurrency ?? 64}`
  );
  const devices = await api.discovery.sweep(sweepCidr, sweepOpts);
  console.error(`Found ${devices.length} device(s) in ${Date.now() - started}ms.`);
  console.log(JSON.stringify(devices, null, 2));
  process.exit(0);
}

// Broadcast discovery — local subnet.
const timeoutMs = explicitTimeout ?? 3000;
const opts: DiscoverOptions = { port, timeoutMs };
if (baseIp) opts.baseIp = baseIp;
if (broadcast) opts.broadcast = broadcast;
if (bindAddress) opts.bindAddress = bindAddress;
if (maxDevices !== undefined) opts.maxDevices = maxDevices;

try {
  const resolved = resolveBroadcast(baseIp);
  console.error(
    `Using interface=${resolved.interface} bind=${bindAddress ?? resolved.bindAddress} ` +
      `broadcast=${broadcast ?? resolved.broadcast} port=${port} timeoutMs=${timeoutMs}` +
      (maxDevices !== undefined ? ` maxDevices=${maxDevices}` : "")
  );
} catch (err) {
  console.error(
    `Interface auto-detect failed (${(err as Error).message}); ` +
      `using bind=${bindAddress ?? "<os pick>"} broadcast=${broadcast ?? "255.255.255.255"} ` +
      `port=${port} timeoutMs=${timeoutMs}`
  );
}

const devices = await api.discovery.discover(opts);
console.error(`Found ${devices.length} device(s) in ${Date.now() - started}ms.`);
console.log(JSON.stringify(devices, null, 2));

process.exit(0);
