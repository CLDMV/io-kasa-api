#!/usr/bin/env node
/**
 * Live device exercise: locate a Kasa device by MAC, then run an
 * on/off + dimming sequence against it, verifying each step.
 *
 * Usage:
 *   node --experimental-strip-types tools/devtest.mts <MAC> [cidr]
 *
 * Defaults: MAC 1C:61:B4:FF:23:E1, CIDR from KASA_SWEEP or 10.8.0.0/23.
 */
import { createKasaApi } from "../src/index.mts";

const mac = process.argv[2] ?? "1C:61:B4:FF:23:E1";
const cidr = process.argv[3] ?? process.env.KASA_SWEEP ?? "10.8.0.0/23";

const normMac = (m: string): string => m.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const api = await createKasaApi();

console.log(`Sweeping ${cidr} for ${mac} ...`);
const devices = await api.discovery.sweep(cidr, { timeoutMs: 1000, concurrency: 128 });
const found = devices.find(
  (d) => normMac(String(d.sysInfo.mac ?? d.sysInfo.mic_mac ?? "")) === normMac(mac)
);
if (!found) {
  console.error(`Device ${mac} not found among ${devices.length} devices on ${cidr}.`);
  process.exit(1);
}
const target = { host: found.host };
console.log(`Found: "${found.sysInfo.alias}" (${found.sysInfo.model}) at ${found.host}\n`);

let pass = 0;
let fail = 0;

/** Run one step: perform `action`, settle, then check `verify`. */
async function step(label: string, action: () => Promise<void>, verify: () => Promise<boolean>): Promise<void> {
  process.stdout.write(`• ${label} ... `);
  try {
    await action();
    await sleep(1200);
    const ok = await verify();
    console.log(ok ? "OK" : "MISMATCH");
    if (ok) pass++;
    else fail++;
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`);
    fail++;
  }
}

const stateIs = (want: 0 | 1) => async (): Promise<boolean> => (await api.switch.getState(target)) === want;
const brightnessIs = (want: number) => async (): Promise<boolean> => {
  const info = await api.device.getSysInfo(target);
  return Number(info.brightness) === want;
};

// 1. Toggle it on and off.
await step("turn ON", () => api.switch.on(target), stateIs(1));
await step("turn OFF", () => api.switch.off(target), stateIs(0));

// 2. Turn it on and change its dimming.
await step("turn ON", () => api.switch.on(target), stateIs(1));
for (const level of [25, 50, 75]) {
  await step(`dim to ${level}%`, () => api.dimmer.setBrightness(target, level), brightnessIs(level));
}

// 3. Finish: on, dimmed to 100%.
await step(
  "turn ON + dim to 100%",
  async () => {
    await api.switch.on(target);
    await api.dimmer.setBrightness(target, 100);
  },
  async () => {
    const info = await api.device.getSysInfo(target);
    return info.relay_state === 1 && Number(info.brightness) === 100;
  }
);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
