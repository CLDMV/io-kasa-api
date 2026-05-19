#!/usr/bin/env node
/**
 * Live device exercise: locate a Kasa device by MAC or by name (alias),
 * then run an on/off + dimming sequence against it, verifying each step.
 *
 * Commands never throw — each resolves to an `OpResult`; this script
 * checks `ok` and the device read-back.
 *
 * Usage:
 *   node --experimental-strip-types tools/devtest.mts <MAC|name> [cidr]
 *
 * Defaults: MAC 1C:61:B4:FF:23:E1, CIDR from KASA_SWEEP or 10.8.0.0/23.
 */
import { createKasaApi } from "../src/index.mts";
import { resolveOrExit } from "./_resolve.mts";

const wanted = process.argv[2] ?? "1C:61:B4:FF:23:E1";
const cidr = process.argv[3] ?? process.env.KASA_SWEEP ?? "10.8.0.0/23";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const api = await createKasaApi({ sweepCidr: cidr });

const target = await resolveOrExit(api, wanted);
console.log("");

let pass = 0;
let fail = 0;

/** Run one step: perform `action`, settle, then check `verify`. */
async function step(label: string, action: () => Promise<{ ok: boolean }>, verify: () => Promise<boolean>): Promise<void> {
  process.stdout.write(`• ${label} ... `);
  const result = await action();
  if (!result.ok) {
    console.log(`FAILED (command not ok)`);
    fail++;
    return;
  }
  await sleep(1200);
  const ok = await verify();
  console.log(ok ? "OK" : "MISMATCH");
  if (ok) pass++;
  else fail++;
}

const stateIs = (want: 0 | 1) => async (): Promise<boolean> => {
  const r = await api.switch.power.get(target);
  return r.ok && r.value === want;
};
const brightnessIs = (want: number) => async (): Promise<boolean> => {
  const r = await api.device.info.get(target);
  return r.ok && Number(r.value?.brightness) === want;
};

// 1. Toggle it on and off.
await step("turn ON", () => api.switch.on(target), stateIs(1));
await step("turn OFF", () => api.switch.off(target), stateIs(0));

// 2. Turn it on and change its dimming.
await step("turn ON", () => api.switch.on(target), stateIs(1));
for (const level of [25, 50, 75]) {
  await step(`dim to ${level}%`, () => api.dimmer.brightness.set(target, level), brightnessIs(level));
}

// 3. Finish: on, dimmed to 100%.
await step(
  "turn ON + dim to 100%",
  () => api.dimmer.brightness.set(target, 100),
  async () => {
    const r = await api.device.info.get(target);
    return r.ok && r.value?.relay_state === 1 && Number(r.value?.brightness) === 100;
  }
);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
