#!/usr/bin/env node
/**
 * Full data dump for a single Kasa device.
 *
 * Probes every known port-9999 namespace/method individually (so an
 * unsupported module can't poison the rest) and prints whatever the
 * device returns — current state, all sensor configs, schedules,
 * countdown/anti-theft rules, dimmer behaviour, time, cloud, Wi-Fi.
 *
 * Each probe is sent on its own connection via `api.protocol.send`.
 * A namespace the device lacks comes back with `err_code != 0` (often
 * "module not support") — that's printed too, so the absence is visible.
 *
 * Usage:
 *   node --experimental-strip-types tools/dumpall.mts ["<alias>"] [cidr]
 *
 * Defaults: alias "Pantry Light", CIDR from KASA_SWEEP or 10.8.0.0/23.
 */
import { createKasaApi } from "../src/index.mts";

const aliasArg = process.argv[2] ?? "Pantry Light";
const cidr = process.argv[3] ?? process.env.KASA_SWEEP ?? "10.8.0.0/23";

const api = await createKasaApi();

const norm = (s: string): string => s.trim().toLowerCase();

console.log(`Sweeping ${cidr} for "${aliasArg}" ...`);
const devices = await api.discovery.sweep(cidr, { timeoutMs: 1000, concurrency: 128 });
const found = devices.find((d) => norm(String(d.sysInfo.alias ?? "")) === norm(aliasArg));
if (!found) {
  console.error(`Device "${aliasArg}" not found among ${devices.length} devices on ${cidr}.`);
  process.exit(1);
}
const target = { host: found.host, timeoutMs: 2000 };
console.log(`Found: "${found.sysInfo.alias}" (${found.sysInfo.model}) at ${found.host}\n`);

/** A namespace/method probe. `arg` is the request body (default `{}`). */
type Probe = { ns: string; method: string; arg?: Record<string, unknown> };

const PROBES: Probe[] = [
  // Core
  { ns: "system", method: "get_sysinfo" },
  // Time
  { ns: "time", method: "get_time" },
  { ns: "time", method: "get_timezone" },
  // Wi-Fi / network
  { ns: "netif", method: "get_scaninfo", arg: { refresh: 0 } },
  // Cloud
  { ns: "cnCloud", method: "get_info" },
  { ns: "smartlife.iot.common.cloud", method: "get_info" },
  // Motion (PIR) sensor
  { ns: "smartlife.iot.PIR", method: "get_config" },
  { ns: "smartlife.iot.PIR", method: "get_adc_value" },
  // Ambient-light (LAS) sensor
  { ns: "smartlife.iot.LAS", method: "get_config" },
  { ns: "smartlife.iot.LAS", method: "get_adc_value" },
  // Dimmer
  { ns: "smartlife.iot.dimmer", method: "get_dimmer_parameters" },
  { ns: "smartlife.iot.dimmer", method: "get_default_behavior" },
  // Rules
  { ns: "smartlife.iot.common.schedule", method: "get_rules" },
  { ns: "smartlife.iot.common.schedule", method: "get_next_action" },
  { ns: "smartlife.iot.common.count_down", method: "get_rules" },
  { ns: "smartlife.iot.common.anti_theft", method: "get_rules" },
  // Energy (unlikely on a dimmer, probed for completeness)
  { ns: "smartlife.iot.common.emeter", method: "get_realtime" },
  { ns: "emeter", method: "get_realtime" }
];

for (const { ns, method, arg } of PROBES) {
  const label = `${ns}.${method}`;
  process.stdout.write(`── ${label} ${"─".repeat(Math.max(0, 56 - label.length))}\n`);
  try {
    const response = (await api.protocol.send(target, { [ns]: { [method]: arg ?? {} } })) as Record<
      string,
      Record<string, unknown>
    >;
    const section = response[ns]?.[method];
    if (section === undefined) {
      console.dir(response, { depth: null, colors: true });
    } else {
      console.dir(section, { depth: null, colors: true });
    }
  } catch (err) {
    console.log(`  (no response: ${(err as Error).message})`);
  }
  console.log("");
}

process.exit(0);
