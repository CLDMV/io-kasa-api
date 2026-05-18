#!/usr/bin/env node
/**
 * Live demo of the debounced PIR motion watcher.
 *
 * Locates a motion switch by alias and runs `api.monitor.watchMotion` — the
 * watcher polls the PIR, collapses each chattery ADC burst into a single
 * `motion` event, and emits `clear` once the sensor has been quiet for the
 * clear window. Walk in front of the device and you should see exactly one
 * `motion` per pass, then a `clear`.
 *
 * Pass `--relay` to instead demo `watch({ motion: true })` — relay on/off
 * events alongside motion/clear from one watcher.
 *
 * `--interval=<ms>` tunes the PIR poll rate (default 400, floored at 250 by
 * the watcher) — use it to find how slow you can poll and still catch
 * motion. `--clear=<ms>` is the quiet window before `clear` fires.
 *
 * Usage:
 *   node --experimental-strip-types tools/motionwatch.mts ["<alias>"] [cidr] \
 *     [--relay] [--interval=<ms>] [--clear=<ms>]
 *
 * Defaults: alias "Pantry Light", CIDR from KASA_SWEEP or 10.8.0.0/23,
 * interval 400ms, clear 5000ms.
 */
import { createKasaApi } from "../src/index.mts";

const args = process.argv.slice(2);
const relayMode = args.includes("--relay");
const positional = args.filter((a) => !a.startsWith("--"));
const aliasArg = positional[0] ?? "Pantry Light";
const cidr = positional[1] ?? process.env.KASA_SWEEP ?? "10.8.0.0/23";

/** Read a `--name=<number>` flag, falling back to `def`. */
const numFlag = (name: string, def: number): number => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  const value = hit ? Number(hit.slice(name.length + 3)) : NaN;
  return Number.isFinite(value) ? value : def;
};
const intervalMs = numFlag("interval", 400);
const clearMs = numFlag("clear", 5000);

const api = await createKasaApi();

const norm = (s: string): string => s.trim().toLowerCase();
const ts = (): string => new Date().toLocaleTimeString();

console.log(`Sweeping ${cidr} for "${aliasArg}" ...`);
const devices = await api.discovery.sweep(cidr, { timeoutMs: 1000, concurrency: 128 });
const found = devices.find((d) => norm(String(d.sysInfo.alias ?? "")) === norm(aliasArg));
if (!found) {
  console.error(`Device "${aliasArg}" not found among ${devices.length} devices on ${cidr}.`);
  process.exit(1);
}
const target = { host: found.host };
console.log(`Found: "${found.sysInfo.alias}" (${found.sysInfo.model}) at ${found.host}\n`);

const monitor = relayMode
  ? api.monitor.watch(target, { motion: true, intervalMs: 2000, motionIntervalMs: intervalMs, motionClearMs: clearMs })
  : api.monitor.watchMotion(target, { intervalMs, clearMs });

console.log(
  relayMode
    ? "Watching relay + motion (watch with motion:true). Move in front; toggle the light too."
    : "Watching motion (watchMotion). Move in front of the sensor."
);
console.log(`PIR poll interval ${intervalMs}ms (floor 250), clear window ${clearMs}ms. Ctrl-C to stop.\n`);

monitor.on("motion", (e) => console.log(`[${ts()}] ★ MOTION   percent=${e.percent.toFixed(0)}%  adc=${e.adcValue}`));
monitor.on("clear", (e) => console.log(`[${ts()}]   cleared   after ${e.durationMs}ms of motion`));
monitor.on("error", (e) => console.log(`[${ts()}]   (poll error: ${e.message})`));

if (relayMode) {
  monitor.on("state", (e) => console.log(`[${ts()}]   relay baseline: ${e.relayState === 1 ? "ON" : "OFF"}`));
  monitor.on("on", (e) => console.log(`[${ts()}] ▲ relay ON   (triggeredBy=${e.triggeredBy})`));
  monitor.on("off", () => console.log(`[${ts()}] ▼ relay OFF`));
}

process.on("SIGINT", () => {
  monitor.stop();
  console.log("\nStopped.");
  process.exit(0);
});
