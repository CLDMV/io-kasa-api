/**
 * Smart-bulb control (LB-series, KL-series).
 *
 * Bulbs use the `smartlife.iot.smartbulb.lightingservice` namespace —
 * a single `transition_light_state` call modifies on/off, brightness,
 * hue/saturation, and color temperature in one round trip.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, LightState, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

const NAMESPACE = "smartlife.iot.smartbulb.lightingservice";
const TRANSITION = "transition_light_state";

function checkError(result: unknown, op: string): LightState {
	if (!result || typeof result !== "object") {
		throw new Error(`Kasa bulb.${op}: unexpected response shape`);
	}
	const obj = result as { err_code?: number; err_msg?: string };
	if (typeof obj.err_code === "number" && obj.err_code !== 0) {
		throw new Error(`Kasa bulb.${op} failed: ${obj.err_msg ?? `err_code ${obj.err_code}`}`);
	}
	return result as unknown as LightState;
}

async function transition(target: DeviceTarget, state: Partial<LightState>, op: string): Promise<LightState> {
	const response = await self.protocol.send(target, {
		[NAMESPACE]: { [TRANSITION]: { ignore_default: 1, ...state } }
	});
	return checkError(response[NAMESPACE]?.[TRANSITION], op);
}

/** Turn the bulb on, optionally with a fade-in transition in milliseconds. */
export async function on(target: DeviceTarget, transitionMs?: number): Promise<void> {
	const state: Partial<LightState> = { on_off: 1 };
	if (typeof transitionMs === "number") state.transition_period = transitionMs;
	await transition(target, state, "on");
}

/** Turn the bulb off. */
export async function off(target: DeviceTarget, transitionMs?: number): Promise<void> {
	const state: Partial<LightState> = { on_off: 0 };
	if (typeof transitionMs === "number") state.transition_period = transitionMs;
	await transition(target, state, "off");
}

/** Read the current light state. */
export async function getLightState(target: DeviceTarget): Promise<LightState> {
	const response = await self.protocol.send(target, {
		[NAMESPACE]: { get_light_state: {} }
	});
	return checkError(response[NAMESPACE]?.get_light_state, "getLightState");
}

/** Apply an arbitrary partial light state. Useful for combined changes. */
export async function setLightState(target: DeviceTarget, state: Partial<LightState>): Promise<LightState> {
	return await transition(target, state, "setLightState");
}

/** 1..100 brightness. Color bulbs only — color-temp-only bulbs ignore this when in white mode. */
export async function setBrightness(target: DeviceTarget, brightness: number, transitionMs?: number): Promise<void> {
	if (brightness < 1 || brightness > 100) {
		throw new RangeError(`brightness must be 1..100, got ${brightness}`);
	}
	const state: Partial<LightState> = { on_off: 1, brightness };
	if (typeof transitionMs === "number") state.transition_period = transitionMs;
	await transition(target, state, "setBrightness");
}

/**
 * Set color via HSV. `value` (0..100) acts as brightness; defaults to 100 if omitted.
 * `hue` is 0..360, `saturation` is 0..100. Setting `color_temp:0` switches the bulb
 * out of white-temperature mode into RGB mode.
 */
export async function setColor(
	target: DeviceTarget,
	hsv: { hue: number; saturation: number; value?: number },
	transitionMs?: number
): Promise<void> {
	if (hsv.hue < 0 || hsv.hue > 360) throw new RangeError(`hue must be 0..360, got ${hsv.hue}`);
	if (hsv.saturation < 0 || hsv.saturation > 100) {
		throw new RangeError(`saturation must be 0..100, got ${hsv.saturation}`);
	}
	const brightness = hsv.value ?? 100;
	if (brightness < 1 || brightness > 100) {
		throw new RangeError(`value (brightness) must be 1..100, got ${brightness}`);
	}
	const state: Partial<LightState> = {
		on_off: 1,
		color_temp: 0,
		hue: Math.round(hsv.hue),
		saturation: Math.round(hsv.saturation),
		brightness
	};
	if (typeof transitionMs === "number") state.transition_period = transitionMs;
	await transition(target, state, "setColor");
}

/**
 * Set color temperature in Kelvin. Valid range depends on the bulb
 * (e.g. LB100: fixed; LB120: 2700–6500; LB130: 2500–9000) — the device will
 * clamp or reject out-of-range values.
 */
export async function setColorTemp(target: DeviceTarget, kelvin: number, transitionMs?: number): Promise<void> {
	if (kelvin < 0) throw new RangeError(`color_temp must be >= 0, got ${kelvin}`);
	const state: Partial<LightState> = { on_off: 1, color_temp: Math.round(kelvin) };
	if (typeof transitionMs === "number") state.transition_period = transitionMs;
	await transition(target, state, "setColorTemp");
}
