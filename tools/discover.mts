#!/usr/bin/env node
/**
 * Run Kasa UDP discovery and print the raw `DiscoveredDevice[]`.
 *
 * Broadcast is auto-detected from the host's first non-internal IPv4 interface
 * unless overridden via CLI args or env vars.
 *
 * Usage (CLI):
 *   npm run discover                                  # auto-detect
 *   npm run discover -- 192.168.1.10                  # positional baseIp
 *   npm run discover -- --base-ip 192.168.1.10
 *   npm run discover -- --broadcast 10.0.5.255 --bind 10.0.1.42
 *   npm run discover -- --port 9999 --timeout 5000 --max 3
 *
 * Usage (env vars — still supported):
 *   KASA_BASE_IP=192.168.1.10 npm run discover
 *   KASA_BROADCAST=10.0.5.255 KASA_BIND=10.0.1.42 npm run discover
 *   KASA_TIMEOUT_MS=5000 KASA_PORT=9999 npm run discover
 */
import { createKasaApi } from "../src/index.mts";
import { resolveBroadcast } from "../src/api/discovery/discovery.mts";
import type { DiscoverOptions } from "../src/lib/types.mts";

interface CliArgs {
  baseIp?: string;
  broadcast?: string;
  bindAddress?: string;
  port?: number;
  timeoutMs?: number;
  maxDevices?: number;
  help?: boolean;
}

const USAGE = `Usage: npm run discover -- [baseIp] [--broadcast IP] [--bind IP] [--port N] [--timeout MS] [--max N]

Positional:
  baseIp           Any IPv4 on the target subnet. Picks the matching local
                   interface and computes its directed broadcast.

Flags:
  --base-ip IP     Same as the positional argument.
  --broadcast IP   Force a specific broadcast destination (overrides auto).
  --bind IP        Force the local interface bind address (overrides auto).
  --port N         UDP port. Default 9999.
  --timeout MS     How long to listen for replies. Default 3000.
  --max N          Stop after this many devices respond.
  -h, --help       Show this help.

Env vars (override defaults; CLI args override env):
  KASA_BASE_IP, KASA_BROADCAST, KASA_BIND, KASA_PORT, KASA_TIMEOUT_MS, KASA_MAX_DEVICES`;

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
const port = cli.port ?? Number(process.env.KASA_PORT ?? "9999");
const timeoutMs = cli.timeoutMs ?? Number(process.env.KASA_TIMEOUT_MS ?? "3000");
const maxDevices = cli.maxDevices ?? (process.env.KASA_MAX_DEVICES ? Number(process.env.KASA_MAX_DEVICES) : undefined);

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

const api = await createKasaApi();
const started = Date.now();
const devices = await api.discovery.discover(opts);
const elapsed = Date.now() - started;

console.error(`Found ${devices.length} device(s) in ${elapsed}ms.`);
console.log(JSON.stringify(devices, null, 2));

process.exit(0);
