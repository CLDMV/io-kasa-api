/**
 * Dimmer-switch brightness control (HS220, KS220, KS230).
 *
 * A dimmer switch is a relay + a brightness stage. On/off goes through the
 * shared relay path — use `plug`/`switch` for that. This module drives the
 * `smartlife.iot.dimmer` namespace: brightness, fade/gentle ramps, and the
 * physical double-click / long-press button actions.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, DimmerParameters, DimmerActionMode, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;
const NS = "smartlife.iot.dimmer";

function unwrap<T>(response: Record<string, Record<string, unknown>>, method: string): T {
	const result = response[NS]?.[method];
	if (result === undefined) throw new Error(`Kasa dimmer.${method}: missing in response`);
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			throw new Error(`Kasa dimmer.${method} failed: ${msg}`);
		}
	}
	return result as T;
}

function assertBrightness(brightness: number): void {
	if (!Number.isInteger(brightness) || brightness < 1 || brightness > 100) {
		throw new RangeError(`brightness must be an integer 1..100, got ${brightness}`);
	}
}

/**
 * Set the dimmer brightness (1..100). This also powers the load on — the
 * device has no concept of "on at 0%".
 */
export async function setBrightness(target: DeviceTarget, brightness: number): Promise<void> {
	assertBrightness(brightness);
	const response = await self.protocol.send(target, { [NS]: { set_brightness: { brightness } } });
	unwrap(response, "set_brightness");
}

/**
 * Ramp to a brightness over `durationMs`. `mode` selects the device's ramp
 * curve ("gentle_on_off" by default); the firmware clamps unknown values.
 */
export async function setBrightnessTransition(
	target: DeviceTarget,
	brightness: number,
	durationMs: number,
	mode = "gentle_on_off"
): Promise<void> {
	assertBrightness(brightness);
	if (durationMs < 0) throw new RangeError(`durationMs must be >= 0, got ${durationMs}`);
	const response = await self.protocol.send(target, {
		[NS]: { set_dimmer_transition: { brightness, mode, duration: Math.round(durationMs) } }
	});
	unwrap(response, "set_dimmer_transition");
}

/** Read the dimmer's tuning parameters (fade times, ramp rate, min threshold, bulb type). */
export async function getParameters(target: DeviceTarget): Promise<DimmerParameters> {
	const response = await self.protocol.send(target, { [NS]: { get_dimmer_parameters: {} } });
	return unwrap<DimmerParameters>(response, "get_dimmer_parameters");
}

/** Fade-in duration (ms) applied when the load is switched on. */
export async function setFadeOnTime(target: DeviceTarget, ms: number): Promise<void> {
	if (ms < 0) throw new RangeError(`fade time must be >= 0, got ${ms}`);
	const response = await self.protocol.send(target, { [NS]: { set_fade_on_time: { fadeTime: Math.round(ms) } } });
	unwrap(response, "set_fade_on_time");
}

/** Fade-out duration (ms) applied when the load is switched off. */
export async function setFadeOffTime(target: DeviceTarget, ms: number): Promise<void> {
	if (ms < 0) throw new RangeError(`fade time must be >= 0, got ${ms}`);
	const response = await self.protocol.send(target, { [NS]: { set_fade_off_time: { fadeTime: Math.round(ms) } } });
	unwrap(response, "set_fade_off_time");
}

/** "Gentle" (slow) on-ramp duration (ms) used by the gentle button mode. */
export async function setGentleOnTime(target: DeviceTarget, ms: number): Promise<void> {
	if (ms < 0) throw new RangeError(`gentle time must be >= 0, got ${ms}`);
	const response = await self.protocol.send(target, { [NS]: { set_gentle_on_time: { duration: Math.round(ms) } } });
	unwrap(response, "set_gentle_on_time");
}

/** "Gentle" (slow) off-ramp duration (ms). */
export async function setGentleOffTime(target: DeviceTarget, ms: number): Promise<void> {
	if (ms < 0) throw new RangeError(`gentle time must be >= 0, got ${ms}`);
	const response = await self.protocol.send(target, { [NS]: { set_gentle_off_time: { duration: Math.round(ms) } } });
	unwrap(response, "set_gentle_off_time");
}

/**
 * Configure what a physical double-click does. `"preset"` mode jumps to the
 * given brightness; the other modes ignore it.
 */
export async function setDoubleClickAction(
	target: DeviceTarget,
	mode: DimmerActionMode,
	brightness?: number
): Promise<void> {
	const args: Record<string, unknown> = { mode };
	if (brightness !== undefined) {
		assertBrightness(brightness);
		args.index = brightness;
	}
	const response = await self.protocol.send(target, { [NS]: { set_double_click_action: args } });
	unwrap(response, "set_double_click_action");
}

/** Configure what a physical long-press does. See {@link setDoubleClickAction}. */
export async function setLongPressAction(
	target: DeviceTarget,
	mode: DimmerActionMode,
	brightness?: number
): Promise<void> {
	const args: Record<string, unknown> = { mode };
	if (brightness !== undefined) {
		assertBrightness(brightness);
		args.index = brightness;
	}
	const response = await self.protocol.send(target, { [NS]: { set_long_press_action: args } });
	unwrap(response, "set_long_press_action");
}
