#!/usr/bin/env node
/**
 * Live poll-watch: locate a Kasa device by alias, then poll its full
 * `get_sysinfo` on an interval and report everything it exposes.
 *
 * The first poll prints the complete sysInfo object — every field the
 * device reports. Each later poll prints only the fields that *changed*
 * since the previous poll, timestamped. Walk in front of a motion device
 * and watch which fields move: that tells us whether motion is
 * distinguishable from a plain on/off (e.g. `active_mode`, `on_time`).
 *
 * Usage:
 *   node --experimental-strip-types tools/pollwatch.mts ["<alias>"] [cidr] [intervalMs]
 *
 * Defaults: alias "Pantry Light", CIDR from KASA_SWEEP or 10.8.0.0/23,
 * interval 1000ms.
 */
import { createKasaApi } from "../src/index.mts";

const aliasArg = process.argv[2] ?? "Pantry Light";
const cidr = process.argv[3] ?? process.env.KASA_SWEEP ?? "10.8.0.0/23";
const intervalMs = Number(process.argv[4] ?? 1000);

const api = await createKasaApi();

const norm = (s: string): string => s.trim().toLowerCase();

console.log(`Sweeping ${cidr} for "${aliasArg}" ...`);
const devices = await api.discovery.sweep(cidr, { timeoutMs: 1000, concurrency: 128 });
const found = devices.find((d) => norm(String(d.sysInfo.alias ?? "")) === norm(aliasArg));
if (!found) {
  console.error(`Device "${aliasArg}" not found among ${devices.length} devices on ${cidr}.`);
  console.error(`Aliases seen: ${devices.map((d) => d.sysInfo.alias).join(", ")}`);
  process.exit(1);
}
const target = { host: found.host };
console.log(`Found: "${found.sysInfo.alias}" (${found.sysInfo.model}) at ${found.host}`);
console.log(`Polling every ${intervalMs}ms — press Ctrl-C to stop.\n`);

/** Stable JSON for value comparison (sorts object keys). */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort())
      : val
  );

let prev: Record<string, unknown> | null = null;
let pollCount = 0;
let stopped = false;

process.on("SIGINT", () => {
  stopped = true;
  console.log(`\nStopped after ${pollCount} polls.`);
  process.exit(0);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ts = (): string => new Date().toLocaleTimeString();

while (!stopped) {
  pollCount++;
  const result = await api.device.info.get(target);

  if (!result.ok || !result.value) {
    console.log(`[${ts()}] poll #${pollCount}: unreachable — ${result.error ?? "no value"}`);
    await sleep(intervalMs);
    continue;
  }

  const info = result.value as Record<string, unknown>;

  if (prev === null) {
    console.log(`[${ts()}] poll #${pollCount}: full sysInfo —`);
    console.dir(info, { depth: null, colors: true });
    console.log("");
  } else {
    const changes: string[] = [];
    const keys = new Set([...Object.keys(prev), ...Object.keys(info)]);
    for (const key of [...keys].sort()) {
      const before = stable(prev[key]);
      const after = stable(info[key]);
      if (before !== after) changes.push(`    ${key}: ${before ?? "—"} → ${after ?? "—"}`);
    }
    if (changes.length > 0) {
      console.log(`[${ts()}] poll #${pollCount}: ${changes.length} field(s) changed —`);
      console.log(changes.join("\n"));
    } else {
      process.stdout.write(`\r[${ts()}] poll #${pollCount}: no change   `);
    }
  }

  prev = info;
  await sleep(intervalMs);
}
