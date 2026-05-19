#!/usr/bin/env node
/**
 * Fast PIR-ADC probe for a Kasa motion switch.
 *
 * The 1s poll in motiontest.mts showed `smartlife.iot.PIR get_adc_value`
 * just idling around ~2000. This probes it fast (default 250ms) and keeps
 * a rolling min/max/mean window, so you can stand still to learn the
 * baseline, then wave at the sensor and see whether the ADC actually
 * spikes. If it never moves beyond the still-baseline noise, the ES20M
 * exposes no usable live motion read and detection must be behavioral.
 *
 * It first dumps the full PIR and ambient-light (LAS) config — everything
 * those namespaces expose — so we can see if any other field looks live.
 *
 * Usage:
 *   node --experimental-strip-types tools/adcprobe.mts ["<alias>"] [cidr] [intervalMs]
 *
 * Defaults: alias "Pantry Light", CIDR from KASA_SWEEP or 10.8.0.0/23,
 * interval 250ms. Run with the light OFF for a clean reading.
 */
import { createKasaApi } from "../src/index.mts";
import { resolveOrExit } from "./_resolve.mts";

const aliasArg = process.argv[2] ?? "Pantry Light";
const cidr = process.argv[3] ?? process.env.KASA_SWEEP ?? "10.8.0.0/23";
const intervalMs = Math.max(100, Number(process.argv[4] ?? 250));

const api = await createKasaApi({ sweepCidr: cidr });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ts = (): string => new Date().toLocaleTimeString();

const target = await resolveOrExit(api, aliasArg);
console.log("");

// Dump everything the PIR and LAS namespaces report.
console.log("── PIR config (smartlife.iot.PIR get_config) ───────────");
const pirCfg = await api.motion.pir.get(target);
if (pirCfg.ok) console.dir(pirCfg.value, { depth: null, colors: true });
else console.log(`  unavailable: ${pirCfg.error}`);

console.log("\n── Ambient-light config (smartlife.iot.LAS get_config) ──");
const lasCfg = await api.motion.ambient.get(target);
if (lasCfg.ok) console.dir(lasCfg.value, { depth: null, colors: true });
else console.log(`  unavailable: ${lasCfg.error}`);

console.log(`\n── PIR ADC — polling every ${intervalMs}ms ─────────────────`);
console.log("Stand still ~15s to learn the baseline, then wave at the sensor.");
console.log("Watch min/max: a real motion read will break out of the still band.");
console.log("Press Ctrl-C to stop.\n");

let stopped = false;
let samples = 0;
const window: number[] = [];
const WINDOW = 40; // rolling window length

process.on("SIGINT", () => {
  stopped = true;
  console.log(`\nStopped after ${samples} samples.`);
  process.exit(0);
});

while (!stopped) {
  const r = await api.motion.pir.adc.get(target);
  samples++;
  if (!r.ok) {
    process.stdout.write(`\r[${ts()}] adc unavailable — ${r.error}            `);
  } else {
    const value = Number(r.value);
    window.push(value);
    if (window.length > WINDOW) window.shift();
    const min = Math.min(...window);
    const max = Math.max(...window);
    const mean = Math.round(window.reduce((a, b) => a + b, 0) / window.length);
    const bar = "█".repeat(Math.min(40, Math.max(0, Math.round((value - min) / Math.max(1, max - min) * 40))));
    process.stdout.write(`\r[${ts()}] adc=${String(value).padStart(5)}  win[min=${min} mean=${mean} max=${max}] ${bar.padEnd(40)}`);
  }
  await sleep(intervalMs);
}
