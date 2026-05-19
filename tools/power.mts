#!/usr/bin/env node
/**
 * Turn a Kasa device on / off / toggle, addressed by name (alias) or MAC.
 *
 * Works for relay devices — plugs, switches, dimmers (all share
 * `system.set_relay_state`). Reads the relay back to confirm.
 *
 * Usage:
 *   node --experimental-strip-types tools/power.mts <MAC|name> <on|off|toggle> [cidr]
 *
 * Defaults: CIDR from KASA_SWEEP or 10.8.0.0/23.
 */
import { createKasaApi } from "../src/index.mts";
import { resolveOrExit } from "./_resolve.mts";

const wanted = process.argv[2];
const action = (process.argv[3] ?? "").toLowerCase();
const cidr = process.argv[4] ?? process.env.KASA_SWEEP ?? "10.8.0.0/23";

if (!wanted || !["on", "off", "toggle"].includes(action)) {
  console.error("Usage: power.mts <MAC|name|ip> <on|off|toggle> [cidr]");
  process.exit(1);
}

const api = await createKasaApi({ sweepCidr: cidr });

const target = await resolveOrExit(api, wanted);

const result =
  action === "on"
    ? await api.switch.on(target)
    : action === "off"
      ? await api.switch.off(target)
      : await api.switch.toggle(target);

if (!result.ok) {
  console.error(`${action} failed: ${result.error}`);
  process.exit(1);
}

const state = await api.switch.power.get(target);
console.log(`${action} → relay is now ${state.value === 1 ? "ON" : "OFF"}`);
process.exit(0);
