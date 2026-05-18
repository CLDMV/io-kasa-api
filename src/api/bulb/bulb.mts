/**
 * Smart-bulb control (LB-series, KL-series).
 *
 * Bulbs use the `smartlife.iot.smartbulb.lightingservice` namespace — a single
 * `transition_light_state` call modifies on/off, brightness, hue/saturation,
 * and color temperature in one round trip.
 *
 * Every command resolves to an `OpResult` and never throws.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, LightState, OpResult, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;
const NAMESPACE = "smartlife.iot.smartbulb.lightingservice";
const TRANSITION = "transition_light_state";

function checkError(result: unknown, op: string): LightState {
	if (!result || typeof result !== "object") {
		throw new Error(`Kasa bulb.${op}: unexpected response shape`);
	}
	const obj = result as { err_code?: number; err_msg?: string };
	if (typeof obj.err_code === "number" && obj.err_code !== 0) {
		throw new Error(`Kasa bulb.${op}: ${obj.err_msg ?? `err_code ${obj.err_code}`}`);
	}
	return result as unknown as LightState;
}

/** Raw transition call — no event wrapping; used inside `run`. */
async function transition(target: DeviceTarget, state: Partial<LightState>, op: string): Promise<LightState> {
	const response = await self.protocol.send(target, {
		[NAMESPACE]: { [TRANSITION]: { ignore_default: 1, ...state } }
	});
	return checkError(response[NAMESPACE]?.[TRANSITION], op);
}

/** Turn the bulb on, optionally with a fade-in transition in milliseconds. */
export function on(target: DeviceTarget, transitionMs?: number): Promise<OpResult> {
	return self.events.run("bulb.on", target, [transitionMs], () => {
		const state: Partial<LightState> = { on_off: 1 };
		if (typeof transitionMs === "number") state.transition_period = transitionMs;
		return transition(target, state, "on");
	});
}

/** Turn the bulb off. */
export function off(target: DeviceTarget, transitionMs?: number): Promise<OpResult> {
	return self.events.run("bulb.off", target, [transitionMs], () => {
		const state: Partial<LightState> = { on_off: 0 };
		if (typeof transitionMs === "number") state.transition_period = transitionMs;
		return transition(target, state, "off");
	});
}

/** Read the current light state. */
export function getLightState(target: DeviceTarget): Promise<OpResult<LightState>> {
	return self.events.run("bulb.getLightState", target, [], async () => {
		const response = await self.protocol.send(target, { [NAMESPACE]: { get_light_state: {} } });
		return checkError(response[NAMESPACE]?.get_light_state, "getLightState");
	});
}

/** Apply an arbitrary partial light state. Useful for combined changes. */
export function setLightState(target: DeviceTarget, state: Partial<LightState>): Promise<OpResult<LightState>> {
	return self.events.run("bulb.setLightState", target, [state], () => transition(target, state, "setLightState"));
}

/** 1..100 brightness. Color bulbs only — color-temp-only bulbs ignore this in white mode. */
export function setBrightness(target: DeviceTarget, brightness: number, transitionMs?: number): Promise<OpResult> {
	return self.events.run("bulb.setBrightness", target, [brightness, transitionMs], () => {
		if (brightness < 1 || brightness > 100) {
			throw new RangeError(`brightness must be 1..100, got ${brightness}`);
		}
		const state: Partial<LightState> = { on_off: 1, brightness };
		if (typeof transitionMs === "number") state.transition_period = transitionMs;
		return transition(target, state, "setBrightness");
	});
}

/**
 * Set color via HSV. `value` (1..100) acts as brightness; defaults to 100.
 * `hue` is 0..360, `saturation` is 0..100. `color_temp:0` switches RGB mode.
 */
export function setColor(
	target: DeviceTarget,
	hsv: { hue: number; saturation: number; value?: number },
	transitionMs?: number
): Promise<OpResult> {
	return self.events.run("bulb.setColor", target, [hsv, transitionMs], () => {
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
		return transition(target, state, "setColor");
	});
}

/** Set color temperature in Kelvin. Valid range depends on the bulb model. */
export function setColorTemp(target: DeviceTarget, kelvin: number, transitionMs?: number): Promise<OpResult> {
	return self.events.run("bulb.setColorTemp", target, [kelvin, transitionMs], () => {
		if (kelvin < 0) throw new RangeError(`color_temp must be >= 0, got ${kelvin}`);
		const state: Partial<LightState> = { on_off: 1, color_temp: Math.round(kelvin) };
		if (typeof transitionMs === "number") state.transition_period = transitionMs;
		return transition(target, state, "setColorTemp");
	});
}
