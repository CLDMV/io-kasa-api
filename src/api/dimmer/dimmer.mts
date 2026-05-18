/**
 * Dimmer-switch brightness control (HS220, KS220, KS230, ES20M).
 *
 * On/off goes through the shared relay path (`plug`/`switch`). This module
 * drives the `smartlife.iot.dimmer` namespace: brightness, fade/gentle ramps,
 * and physical double-click / long-press button actions.
 *
 * Every command resolves to an `OpResult` and never throws — bad input
 * (e.g. brightness out of range) surfaces as `ok: false`, not an exception.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, DimmerActionMode, DimmerParameters, OpResult, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;
const NS = "smartlife.iot.dimmer";

function unwrap<T>(response: Record<string, Record<string, unknown>>, method: string): T {
	const result = response[NS]?.[method];
	if (result === undefined) throw new Error(`Kasa dimmer.${method}: missing in response`);
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			throw new Error(`Kasa dimmer.${method}: ${msg}`);
		}
	}
	return result as T;
}

function assertBrightness(brightness: number): void {
	if (!Number.isInteger(brightness) || brightness < 1 || brightness > 100) {
		throw new RangeError(`brightness must be an integer 1..100, got ${brightness}`);
	}
}

/** Set the dimmer brightness (1..100). Also powers the load on. */
export function setBrightness(target: DeviceTarget, brightness: number): Promise<OpResult> {
	return self.events.run("dimmer.setBrightness", target, [brightness], async () => {
		assertBrightness(brightness);
		const response = await self.protocol.send(target, { [NS]: { set_brightness: { brightness } } });
		return unwrap(response, "set_brightness");
	});
}

/** Ramp to a brightness over `durationMs`. `mode` selects the device's ramp curve. */
export function setBrightnessTransition(
	target: DeviceTarget,
	brightness: number,
	durationMs: number,
	mode = "gentle_on_off"
): Promise<OpResult> {
	return self.events.run("dimmer.setBrightnessTransition", target, [brightness, durationMs, mode], async () => {
		assertBrightness(brightness);
		if (durationMs < 0) throw new RangeError(`durationMs must be >= 0, got ${durationMs}`);
		const response = await self.protocol.send(target, {
			[NS]: { set_dimmer_transition: { brightness, mode, duration: Math.round(durationMs) } }
		});
		return unwrap(response, "set_dimmer_transition");
	});
}

/** Read the dimmer's tuning parameters (fade times, ramp rate, min threshold, bulb type). */
export function getParameters(target: DeviceTarget): Promise<OpResult<DimmerParameters>> {
	return self.events.run("dimmer.getParameters", target, [], async () => {
		const response = await self.protocol.send(target, { [NS]: { get_dimmer_parameters: {} } });
		return unwrap<DimmerParameters>(response, "get_dimmer_parameters");
	});
}

/** Fade-in duration (ms) applied when the load is switched on. */
export function setFadeOnTime(target: DeviceTarget, ms: number): Promise<OpResult> {
	return self.events.run("dimmer.setFadeOnTime", target, [ms], async () => {
		if (ms < 0) throw new RangeError(`fade time must be >= 0, got ${ms}`);
		const response = await self.protocol.send(target, { [NS]: { set_fade_on_time: { fadeTime: Math.round(ms) } } });
		return unwrap(response, "set_fade_on_time");
	});
}

/** Fade-out duration (ms) applied when the load is switched off. */
export function setFadeOffTime(target: DeviceTarget, ms: number): Promise<OpResult> {
	return self.events.run("dimmer.setFadeOffTime", target, [ms], async () => {
		if (ms < 0) throw new RangeError(`fade time must be >= 0, got ${ms}`);
		const response = await self.protocol.send(target, { [NS]: { set_fade_off_time: { fadeTime: Math.round(ms) } } });
		return unwrap(response, "set_fade_off_time");
	});
}

/** "Gentle" (slow) on-ramp duration (ms) used by the gentle button mode. */
export function setGentleOnTime(target: DeviceTarget, ms: number): Promise<OpResult> {
	return self.events.run("dimmer.setGentleOnTime", target, [ms], async () => {
		if (ms < 0) throw new RangeError(`gentle time must be >= 0, got ${ms}`);
		const response = await self.protocol.send(target, { [NS]: { set_gentle_on_time: { duration: Math.round(ms) } } });
		return unwrap(response, "set_gentle_on_time");
	});
}

/** "Gentle" (slow) off-ramp duration (ms). */
export function setGentleOffTime(target: DeviceTarget, ms: number): Promise<OpResult> {
	return self.events.run("dimmer.setGentleOffTime", target, [ms], async () => {
		if (ms < 0) throw new RangeError(`gentle time must be >= 0, got ${ms}`);
		const response = await self.protocol.send(target, { [NS]: { set_gentle_off_time: { duration: Math.round(ms) } } });
		return unwrap(response, "set_gentle_off_time");
	});
}

/** Configure what a physical double-click does. `"preset"` mode jumps to `brightness`. */
export function setDoubleClickAction(
	target: DeviceTarget,
	mode: DimmerActionMode,
	brightness?: number
): Promise<OpResult> {
	return self.events.run("dimmer.setDoubleClickAction", target, [mode, brightness], async () => {
		const args: Record<string, unknown> = { mode };
		if (brightness !== undefined) {
			assertBrightness(brightness);
			args.index = brightness;
		}
		const response = await self.protocol.send(target, { [NS]: { set_double_click_action: args } });
		return unwrap(response, "set_double_click_action");
	});
}

/** Configure what a physical long-press does. See {@link setDoubleClickAction}. */
export function setLongPressAction(
	target: DeviceTarget,
	mode: DimmerActionMode,
	brightness?: number
): Promise<OpResult> {
	return self.events.run("dimmer.setLongPressAction", target, [mode, brightness], async () => {
		const args: Record<string, unknown> = { mode };
		if (brightness !== undefined) {
			assertBrightness(brightness);
			args.index = brightness;
		}
		const response = await self.protocol.send(target, { [NS]: { set_long_press_action: args } });
		return unwrap(response, "set_long_press_action");
	});
}
