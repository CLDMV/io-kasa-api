/**
 * Smart-bulb control (LB-series, KL-series), addressed as resources:
 *   bulb.state.{get,set} · bulb.power.{get,set} · bulb.on() · bulb.off()
 *   bulb.brightness.{get,set} · bulb.color.{get,set} · bulb.colorTemp.{get,set}
 *
 * Bulbs use the `smartlife.iot.smartbulb.lightingservice` namespace. Derived
 * getters call the same raw `light_state` fetch the parent `state.get` uses.
 * No `throw` in this file — failures return as `self.events.failure(...)`.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { BulbApi, CommandOptions, DeviceTarget, Failure, LightState, OpResult, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;
const NAMESPACE = "smartlife.iot.smartbulb.lightingservice";
const TRANSITION = "transition_light_state";

function checkLightState(result: unknown, op: string): LightState | Failure {
	if (!result || typeof result !== "object") return self.events.failure(`Kasa bulb.${op}: unexpected response shape`);
	const obj = result as { err_code?: number; err_msg?: string };
	if (typeof obj.err_code === "number" && obj.err_code !== 0) {
		return self.events.failure(`Kasa bulb.${op}: ${obj.err_msg ?? `err_code ${obj.err_code}`}`);
	}
	return result as unknown as LightState;
}

/** Raw light-state fetch — shared by `state.get` and the derived getters. */
async function rawLightState(target: DeviceTarget): Promise<LightState | Failure> {
	const response = await self.protocol.send(target, { [NAMESPACE]: { get_light_state: {} } });
	return checkLightState(response[NAMESPACE]?.get_light_state, "state.get");
}

/** Raw transition write — no event wrapping. */
async function rawTransition(target: DeviceTarget, state: Partial<LightState>, op: string): Promise<LightState | Failure> {
	const response = await self.protocol.send(target, {
		[NAMESPACE]: { [TRANSITION]: { ignore_default: 1, ...state } }
	});
	return checkLightState(response[NAMESPACE]?.[TRANSITION], op);
}

/** Verify that every field in `partial` matches what the device reports after the write. */
async function lightStateMatches(target: DeviceTarget, partial: Partial<LightState>): Promise<boolean> {
	const current = await rawLightState(target);
	if (self.events.isFailure(current)) return false;
	const c = current as unknown as Record<string, unknown>;
	for (const [key, want] of Object.entries(partial)) {
		if (key === "transition_period" || key === "ignore_default") continue;
		if (c[key] !== want) return false;
	}
	return true;
}

/** Turn the bulb on, optionally with a fade-in transition (ms). */
export function on(target: DeviceTarget, transitionMs?: number, options?: CommandOptions): Promise<OpResult> {
	return self.events.run(
		"bulb.on",
		target,
		[transitionMs],
		() => {
			const state: Partial<LightState> = { on_off: 1 };
			if (typeof transitionMs === "number") state.transition_period = transitionMs;
			return rawTransition(target, state, "on");
		},
		{
			confirm: options?.confirm,
			verify: async () => {
				const r = await rawLightState(target);
				return !self.events.isFailure(r) && r.on_off === 1;
			}
		}
	);
}

/** Turn the bulb off. */
export function off(target: DeviceTarget, transitionMs?: number, options?: CommandOptions): Promise<OpResult> {
	return self.events.run(
		"bulb.off",
		target,
		[transitionMs],
		() => {
			const state: Partial<LightState> = { on_off: 0 };
			if (typeof transitionMs === "number") state.transition_period = transitionMs;
			return rawTransition(target, state, "off");
		},
		{
			confirm: options?.confirm,
			verify: async () => {
				const r = await rawLightState(target);
				return !self.events.isFailure(r) && r.on_off === 0;
			}
		}
	);
}

/** Full light state. */
export const state: BulbApi["state"] = {
	get: (target) => self.events.run("bulb.state.get", target, [], () => rawLightState(target)),
	set: (target, partial, options) =>
		self.events.run("bulb.state.set", target, [partial], () => rawTransition(target, partial, "state.set"), {
			confirm: options?.confirm,
			verify: () => lightStateMatches(target, partial)
		})
};

/** On/off state. `set` routes to `on`/`off`. */
export const power: BulbApi["power"] = {
	get: (target) =>
		self.events.run("bulb.power.get", target, [], async () => {
			const r = await rawLightState(target);
			return self.events.isFailure(r) ? r : r.on_off === 1;
		}),
	set: (target, isOn, options) => (isOn ? on(target, undefined, options) : off(target, undefined, options))
};

/** Brightness 1..100. `set` takes an optional transition (ms). */
export const brightness: BulbApi["brightness"] = {
	get: (target) =>
		self.events.run("bulb.brightness.get", target, [], async () => {
			const r = await rawLightState(target);
			return self.events.isFailure(r) ? r : r.brightness;
		}),
	set: (target, level, transitionMs, options) =>
		self.events.run(
			"bulb.brightness.set",
			target,
			[level, transitionMs],
			() => {
				if (level < 1 || level > 100) return self.events.failure(`brightness must be 1..100, got ${level}`);
				const next: Partial<LightState> = { on_off: 1, brightness: level };
				if (typeof transitionMs === "number") next.transition_period = transitionMs;
				return rawTransition(target, next, "brightness.set");
			},
			{
				confirm: options?.confirm,
				verify: async () => {
					const r = await rawLightState(target);
					return !self.events.isFailure(r) && r.brightness === level;
				}
			}
		)
};

/** Color as HSV. `set`'s `value` is brightness (defaults 100); `color_temp:0` enters RGB mode. */
export const color: BulbApi["color"] = {
	get: (target) =>
		self.events.run("bulb.color.get", target, [], async () => {
			const ls = await rawLightState(target);
			if (self.events.isFailure(ls)) return ls;
			return { hue: ls.hue ?? 0, saturation: ls.saturation ?? 0, value: ls.brightness ?? 0 };
		}),
	set: (target, hsv, transitionMs, options) => {
		const wantHue = Math.round(hsv.hue);
		const wantSat = Math.round(hsv.saturation);
		const wantLevel = hsv.value ?? 100;
		return self.events.run(
			"bulb.color.set",
			target,
			[hsv, transitionMs],
			() => {
				if (hsv.hue < 0 || hsv.hue > 360) return self.events.failure(`hue must be 0..360, got ${hsv.hue}`);
				if (hsv.saturation < 0 || hsv.saturation > 100) return self.events.failure(`saturation must be 0..100, got ${hsv.saturation}`);
				if (wantLevel < 1 || wantLevel > 100) return self.events.failure(`value (brightness) must be 1..100, got ${wantLevel}`);
				const next: Partial<LightState> = {
					on_off: 1,
					color_temp: 0,
					hue: wantHue,
					saturation: wantSat,
					brightness: wantLevel
				};
				if (typeof transitionMs === "number") next.transition_period = transitionMs;
				return rawTransition(target, next, "color.set");
			},
			{
				confirm: options?.confirm,
				verify: async () => {
					const ls = await rawLightState(target);
					return !self.events.isFailure(ls) && ls.hue === wantHue && ls.saturation === wantSat && ls.brightness === wantLevel;
				}
			}
		);
	}
};

/** White color temperature in Kelvin. Valid range depends on the bulb model. */
export const colorTemp: BulbApi["colorTemp"] = {
	get: (target) =>
		self.events.run("bulb.colorTemp.get", target, [], async () => {
			const r = await rawLightState(target);
			return self.events.isFailure(r) ? r : r.color_temp;
		}),
	set: (target, kelvin, transitionMs, options) => {
		const want = Math.round(kelvin);
		return self.events.run(
			"bulb.colorTemp.set",
			target,
			[kelvin, transitionMs],
			() => {
				if (kelvin < 0) return self.events.failure(`color_temp must be >= 0, got ${kelvin}`);
				const next: Partial<LightState> = { on_off: 1, color_temp: want };
				if (typeof transitionMs === "number") next.transition_period = transitionMs;
				return rawTransition(target, next, "colorTemp.set");
			},
			{
				confirm: options?.confirm,
				verify: async () => {
					const r = await rawLightState(target);
					return !self.events.isFailure(r) && r.color_temp === want;
				}
			}
		);
	}
};
