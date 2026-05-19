#!/usr/bin/env node
/**
 * List Kasa device names (aliases) — one per line, sorted, on stdout.
 *
 * Progress goes to stderr, so stdout stays a clean pipeable name list.
 *
 * Usage:
 *   node --experimental-strip-types tools/list-devices.mts [cidr]
 *
 * Defaults: CIDR from KASA_SWEEP or 10.8.0.0/23.
 */
import { createKasaApi } from "../src/index.mts";

const cidr = process.argv[2] ?? process.env.KASA_SWEEP ?? "10.8.0.0/23";

const api = await createKasaApi({ sweepCidr: cidr });

console.error(`Sweeping ${cidr} ...`);
const devices = await api.devices.list({ timeoutMs: 1000, concurrency: 128 });

const names = devices
  .map((d) => String(d.sysInfo.alias ?? "(unnamed)"))
  .sort((a, b) => a.localeCompare(b));

for (const name of names) console.log(name);
console.error(`${names.length} device(s).`);
process.exit(0);
