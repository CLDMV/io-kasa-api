/**
 * Dimmer-switch control (HS220, KS220, KS230, ES20M), addressed as resources:
 *   dimmer.brightness.{get,set} · dimmer.parameters.get
 *   dimmer.fade.{on,off}.{get,set} · dimmer.gentle.{on,off}.{get,set}
 *   dimmer.doubleClick.set · dimmer.longPress.set
 *
 * On/off goes through `plug`/`switch`. Derived getters (fade/gentle/brightness)
 * call the same raw fetch the parent `get` uses, so each fires exactly one
 * event under its own path. Every command resolves to an `OpResult`.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DimmerApi, DimmerParameters, DeviceTarget, SelfApi, SysInfo } from "../../lib/types.mts";

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

function assertBrightness(level: number): void {
	if (!Number.isInteger(level) || level < 1 || level > 100) {
		throw new RangeError(`brightness must be an integer 1..100, got ${level}`);
	}
}

/** Raw tuning-parameter fetch — shared by `parameters.get` and the fade/gentle getters. */
async function rawParameters(target: DeviceTarget): Promise<DimmerParameters> {
	const response = await self.protocol.send(target, { [NS]: { get_dimmer_parameters: {} } });
	return unwrap<DimmerParameters>(response, "get_dimmer_parameters");
}

/** Raw sysinfo fetch — `brightness` lives in sysinfo, not the dimmer namespace. */
async function rawBrightness(target: DeviceTarget): Promise<number | undefined> {
	const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
	const sysInfo = response.system?.get_sysinfo as SysInfo | undefined;
	return typeof sysInfo?.brightness === "number" ? sysInfo.brightness : undefined;
}

/** Raw `set_*_time` write for the fade/gentle ramp resources. */
async function rawSetTime(target: DeviceTarget, method: string, arg: string, ms: number): Promise<unknown> {
	if (ms < 0) throw new RangeError(`time must be >= 0, got ${ms}`);
	const response = await self.protocol.send(target, { [NS]: { [method]: { [arg]: Math.round(ms) } } });
	return unwrap(response, method);
}

/** Build a fade/gentle ramp resource: derived `get` from `parameters`, `set` via `rawSetTime`. */
function rampResource(
	op: string,
	field: keyof DimmerParameters,
	method: string,
	arg: string
): DimmerApi["fade"]["on"] {
	return {
		get: (target) =>
			self.events.run(`${op}.get`, target, [], async () => {
				const value = (await rawParameters(target))[field];
				return typeof value === "number" ? value : undefined;
			}),
		set: (target, ms) => self.events.run(`${op}.set`, target, [ms], () => rawSetTime(target, method, arg, ms))
	};
}

/** Brightness 1..100. `set` accepts an optional fade duration (ms). */
export const brightness: DimmerApi["brightness"] = {
	get: (target) => self.events.run("dimmer.brightness.get", target, [], () => rawBrightness(target)),
	set: (target, level, durationMs) =>
		self.events.run("dimmer.brightness.set", target, [level, durationMs], async () => {
			assertBrightness(level);
			if (typeof durationMs === "number") {
				if (durationMs < 0) throw new RangeError(`durationMs must be >= 0, got ${durationMs}`);
				const response = await self.protocol.send(target, {
					[NS]: { set_dimmer_transition: { brightness: level, mode: "gentle_on_off", duration: Math.round(durationMs) } }
				});
				return unwrap(response, "set_dimmer_transition");
			}
			const response = await self.protocol.send(target, { [NS]: { set_brightness: { brightness: level } } });
			return unwrap(response, "set_brightness");
		})
};

/** Full dimmer tuning block. */
export const parameters: DimmerApi["parameters"] = {
	get: (target) => self.events.run("dimmer.parameters.get", target, [], () => rawParameters(target))
};

/** Hard fade ramp times (ms). */
export const fade: DimmerApi["fade"] = {
	on: rampResource("dimmer.fade.on", "fadeOnTime", "set_fade_on_time", "fadeTime"),
	off: rampResource("dimmer.fade.off", "fadeOffTime", "set_fade_off_time", "fadeTime")
};

/** Gentle (slow) ramp times (ms). */
export const gentle: DimmerApi["gentle"] = {
	on: rampResource("dimmer.gentle.on", "gentleOnTime", "set_gentle_on_time", "duration"),
	off: rampResource("dimmer.gentle.off", "gentleOffTime", "set_gentle_off_time", "duration")
};

/** Physical double-click action. `"preset"` mode jumps to `brightness`. */
export const doubleClick: DimmerApi["doubleClick"] = {
	set: (target, mode, brightnessLevel) =>
		self.events.run("dimmer.doubleClick.set", target, [mode, brightnessLevel], async () => {
			const args: Record<string, unknown> = { mode };
			if (brightnessLevel !== undefined) {
				assertBrightness(brightnessLevel);
				args.index = brightnessLevel;
			}
			const response = await self.protocol.send(target, { [NS]: { set_double_click_action: args } });
			return unwrap(response, "set_double_click_action");
		})
};

/** Physical long-press action. See {@link doubleClick}. */
export const longPress: DimmerApi["longPress"] = {
	set: (target, mode, brightnessLevel) =>
		self.events.run("dimmer.longPress.set", target, [mode, brightnessLevel], async () => {
			const args: Record<string, unknown> = { mode };
			if (brightnessLevel !== undefined) {
				assertBrightness(brightnessLevel);
				args.index = brightnessLevel;
			}
			const response = await self.protocol.send(target, { [NS]: { set_long_press_action: args } });
			return unwrap(response, "set_long_press_action");
		})
};
