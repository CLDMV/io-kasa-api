#!/usr/bin/env node
/**
 * Live PIR-motion read using python-kasa's calibration-free algorithm.
 *
 * No per-device calibration: the reference point is `adc_mid`, the fixed
 * midpoint of the device's declared ADC range, and the trigger bar comes
 * from the device's own `array[trigger_index]` config. See:
 *   github.com/python-kasa/python-kasa .../kasa/iot/modules/motion.py
 *
 *   adc_mid       = floor(|max_adc - min_adc| / 2)
 *   threshold     = array[trigger_index]
 *   pir_value     = adc_mid - adc_value
 *   divisor       = pir_value < 0 ? adc_mid - min_adc : max_adc - adc_mid
 *   pir_percent   = pir_value / divisor * 100
 *   pir_triggered = enabled && |pir_percent| > (100 - threshold)
 *
 * Reads PIR config once, then polls `get_adc_value` and prints the live
 * computed trigger state. Walk in front of the sensor: if `triggered`
 * flips true, the formula works on this device and we implement it in the
 * API. If it never fires, `get_adc_value` is too filtered and motion
 * detection falls back to behavioral (relay 0->1).
 *
 * Usage:
 *   node --experimental-strip-types tools/pirmotion.mts ["<alias>"] [cidr] [intervalMs]
 *
 * Defaults: alias "Pantry Light", CIDR from KASA_SWEEP or 10.8.0.0/23,
 * interval 200ms.
 */
import { createKasaApi } from "../src/index.mts";
import { resolveOrExit } from "./_resolve.mts";

const aliasArg = process.argv[2] ?? "Pantry Light";
const cidr = process.argv[3] ?? process.env.KASA_SWEEP ?? "10.8.0.0/23";
const intervalMs = Math.max(50, Number(process.argv[4] ?? 200));

const api = await createKasaApi({ sweepCidr: cidr });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ts = (): string => new Date().toLocaleTimeString();

const target = { ...(await resolveOrExit(api, aliasArg)), timeoutMs: 1500 };
console.log("");

// --- PIR config (read once) -----------------------------------------------------
const cfgResult = await api.motion.pir.get(target);
if (!cfgResult.ok || !cfgResult.value) {
  console.error(`Could not read PIR config: ${cfgResult.error ?? "no value"}`);
  process.exit(1);
}
const cfg = cfgResult.value as Record<string, unknown>;
const enabled = Boolean(cfg.enable);
const adcMin = Number(cfg.min_adc);
const adcMax = Number(cfg.max_adc);
const adcMid = Math.floor(Math.abs(adcMax - adcMin) / 2);
const triggerIndex = Number(cfg.trigger_index);
const array = (cfg.array as number[]) ?? [];
const threshold = Number(array[triggerIndex]);
const triggerBar = 100 - threshold; // |pir_percent| must exceed this

console.log("── PIR config (python-kasa model) ──────────────────────");
console.log(`  enabled=${enabled}  adc_min=${adcMin}  adc_max=${adcMax}  adc_mid=${adcMid}`);
console.log(`  trigger_index=${triggerIndex}  array=[${array.join(", ")}]  threshold=${threshold}`);
console.log(`  → motion when |pir_percent| > ${triggerBar}%\n`);

/** python-kasa PIRStatus, computed from a raw ADC reading. */
function pirStatus(adcValue: number): { value: number; percent: number; triggered: boolean } {
  const value = adcMid - adcValue;
  const divisor = value < 0 ? adcMid - adcMin : adcMax - adcMid;
  const percent = divisor === 0 ? 0 : (value / divisor) * 100;
  return { value, percent, triggered: enabled && Math.abs(percent) > triggerBar };
}

// --- Watch ----------------------------------------------------------------------
console.log("── Watching — move in front of the sensor. Ctrl-C to stop. ──\n");
let stopped = false;
let samples = 0;
let triggers = 0;
let wasTriggered = false;
let peakPercent = 0;

process.on("SIGINT", () => {
  stopped = true;
  console.log(`\n\n${samples} samples, ${triggers} trigger event(s), peak |pir_percent|=${peakPercent.toFixed(1)}%.`);
  console.log(
    peakPercent > triggerBar
      ? "→ python-kasa's formula fires on this device — implement motion.pir.triggered in the API."
      : `→ |pir_percent| never reached ${triggerBar}% — get_adc_value is too filtered; use behavioral detection.`
  );
  process.exit(0);
});

while (!stopped) {
  const r = await api.motion.pir.adc.get(target);
  samples++;
  if (!r.ok) {
    process.stdout.write(`\r[${ts()}] (no answer)                                   `);
  } else {
    const adcValue = Number(r.value);
    const s = pirStatus(adcValue);
    peakPercent = Math.max(peakPercent, Math.abs(s.percent));
    if (s.triggered && !wasTriggered) {
      wasTriggered = true;
      triggers++;
      console.log(`\n[${ts()}] ★ MOTION  adc=${adcValue}  pir_percent=${s.percent.toFixed(1)}%`);
    } else if (!s.triggered && wasTriggered) {
      wasTriggered = false;
      console.log(`[${ts()}]   …cleared  adc=${adcValue}  pir_percent=${s.percent.toFixed(1)}%`);
    } else {
      process.stdout.write(
        `\r[${ts()}] adc=${String(adcValue).padStart(5)}  pir_percent=${s.percent.toFixed(1).padStart(7)}%  ${
          s.triggered ? "MOTION" : "idle  "
        }   `
      );
    }
  }
  await sleep(intervalMs);
}
