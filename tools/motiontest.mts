/**
 *	@Project: @cldmv/kasa-api
 *	@Filename: /tools/motiontest.mts
 *	@Date: 2026-05-18 13:35:21 -07:00 (1779136521)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-05-18 14:06:55 -07:00 (1779138415)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Motion-vs-manual experiment for a Kasa motion switch.
 *
 * Question: is `relay_state` a motion flag, or just "the light is on"?
 *
 * Procedure:
 *   1. Find the device by alias and read its current state. If the relay is
 *      already on (you just triggered it), that snapshot is the MOTION-ON
 *      reference.
 *   2. Poll until the relay drops to 0 — i.e. wait out the motion auto-off.
 *      Stay away from the sensor during this phase.
 *   3. Turn the relay on programmatically (a "manual" on).
 *   4. Poll again and capture the MANUAL-ON state.
 *   5. Diff the snapshots: any field that differs between motion-on and
 *      manual-on is a real motion discriminator. If only `relay_state`
 *      differs from off, then relay_state alone cannot tell them apart.
 *
 * Usage:
 *   node --experimental-strip-types tools/motiontest.mts ["<alias>"] [cidr] [intervalMs]
 *
 * Defaults: alias "Pantry Light", CIDR from KASA_SWEEP or 10.8.0.0/23,
 * interval 1000ms.
 */
import { createKasaApi } from "../src/index.mts";
import { resolveOrExit } from "./_resolve.mts";

const aliasArg = process.argv[2] ?? "Pantry Light";
const cidr = process.argv[3] ?? process.env.KASA_SWEEP ?? "10.8.0.0/23";
const intervalMs = Number(process.argv[4] ?? 1000);
/** Safety cap so phase 2 can't poll forever if the relay never drops. */
const MAX_WAIT_MS = 30 * 60 * 1000;

const api = await createKasaApi({ sweepCidr: cidr });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ts = (): string => new Date().toLocaleTimeString();

const target = await resolveOrExit(api, aliasArg);
console.log("");

type Info = Record<string, unknown>;

/** Read full sysInfo; exits on an unreachable device. */
async function readInfo(): Promise<Info> {
	const r = await api.device.info.get(target);
	if (!r.ok || !r.value) {
		console.error(`Device unreachable: ${r.error ?? "no value"}`);
		process.exit(1);
	}
	return r.value as Info;
}

/** Try the live PIR ADC reading; null if this device has no PIR namespace. */
async function readAdc(): Promise<number | null> {
	const r = await api.motion.pir.adc.get(target);
	return r.ok ? Number(r.value) : null;
}

const relay = (i: Info): number => Number(i.relay_state ?? -1);
const summary = (i: Info): string => `relay_state=${i.relay_state} active_mode=${JSON.stringify(i.active_mode)} on_time=${i.on_time}`;

// --- Phase 1: initial read ------------------------------------------------------
console.log("── Phase 1: initial state ──────────────────────────────");
let motionOn: Info | null = null;
const start = await readInfo();
console.log(`[${ts()}] ${summary(start)}  pir.adc=${await readAdc()}`);
if (relay(start) === 1) {
	motionOn = start;
	console.log("Relay is ON — treating this as the MOTION-ON reference.");
} else {
	console.log("Relay is already OFF — no motion-on reference captured.");
	console.log("(Trigger the sensor before running for a full comparison.)");
}
console.log("");

// --- Phase 2: wait for the relay to drop ----------------------------------------
console.log("── Phase 2: waiting for relay to turn OFF ──────────────");
console.log("Stay away from the sensor so the auto-off countdown can finish.\n");
const deadline = Date.now() + MAX_WAIT_MS;
let off: Info | null = null;
while (Date.now() < deadline) {
	const info = await readInfo();
	if (relay(info) === 0) {
		off = info;
		console.log(`[${ts()}] relay is now OFF — ${summary(info)}`);
		break;
	}
	process.stdout.write(`\r[${ts()}] still on — ${summary(info)}        `);
	await sleep(intervalMs);
}
if (!off) {
	console.error(`\nRelay never dropped within ${MAX_WAIT_MS / 1000}s — aborting.`);
	process.exit(1);
}
console.log("\nOFF snapshot:");
console.dir(off, { depth: null, colors: true });
console.log("");

// --- Phase 3: manual turn-on ----------------------------------------------------
console.log("── Phase 3: manual turn-ON via api.switch.on ───────────");
const onResult = await api.switch.on(target);
console.log(`[${ts()}] api.switch.on → ok=${onResult.ok}` + (onResult.ok ? "" : ` error=${onResult.error}`));
await sleep(1500); // let the device settle

// --- Phase 4: observe the manual-on state ---------------------------------------
console.log("\n── Phase 4: manual-ON state ────────────────────────────");
let manualOn: Info | null = null;
for (let i = 0; i < 5; i++) {
	const info = await readInfo();
	console.log(`[${ts()}] poll ${i + 1}/5 — ${summary(info)}  pir.adc=${await readAdc()}`);
	if (i === 4) manualOn = info;
	await sleep(intervalMs);
}
console.log("\nMANUAL-ON snapshot:");
console.dir(manualOn, { depth: null, colors: true });

// --- Verdict --------------------------------------------------------------------
console.log("\n── Verdict ─────────────────────────────────────────────");
console.log(`OFF        : ${summary(off)}`);
if (motionOn) console.log(`MOTION-ON  : ${summary(motionOn)}`);
console.log(`MANUAL-ON  : ${summary(manualOn as Info)}`);
console.log("");

if (motionOn && manualOn) {
	const keys = new Set([...Object.keys(motionOn), ...Object.keys(manualOn)]);
	// Volatile fields move on their own — exclude them from the discriminator check.
	const volatile = new Set(["on_time", "rssi", "updating", "led_off"]);
	const discriminators: string[] = [];
	for (const k of [...keys].sort()) {
		if (volatile.has(k)) continue;
		const a = JSON.stringify(motionOn[k]);
		const b = JSON.stringify(manualOn[k]);
		if (a !== b) discriminators.push(`    ${k}: motion=${a}  manual=${b}`);
	}
	if (discriminators.length > 0) {
		console.log("Fields that DIFFER between motion-on and manual-on:");
		console.log(discriminators.join("\n"));
		console.log("\n→ relay_state is NOT the only signal — motion is distinguishable.");
	} else {
		console.log("No stable field differs between motion-on and manual-on.");
		console.log("→ relay_state=1 is identical for both; it is just 'light is on',");
		console.log("  not a motion flag. Use motion.pir.adc.get for a true motion read.");
	}
} else {
	console.log("No motion-on reference was captured — re-run and trigger the");
	console.log("sensor first to get the full motion-vs-manual comparison.");
}

process.exit(0);
