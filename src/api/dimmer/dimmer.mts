/**
 * Dimmer-switch control (HS220, KS220, KS230, ES20M), addressed as resources:
 *   dimmer.brightness.{get,set} · dimmer.parameters.get
 *   dimmer.fade.{on,off}.{get,set} · dimmer.gentle.{on,off}.{get,set}
 *   dimmer.doubleClick.set · dimmer.longPress.set
 *
 * On/off goes through `plug`/`switch`. Derived getters (fade/gentle/brightness)
 * call the same raw fetch the parent `get` uses, so each fires exactly one
 * event under its own path. No `throw` in this file — failures return as
 * `self.events.failure(...)` sentinels.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type {
	DimmerActionMode,
	DimmerApi,
	DimmerParameters,
	DeviceTarget,
	Failure,
	SelfApi,
	SysInfo
} from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;
const NS = "smartlife.iot.dimmer";

function unwrap<T>(response: Record<string, Record<string, unknown>>, method: string): T | Failure {
	const result = response[NS]?.[method];
	if (result === undefined) return self.events.failure(`Kasa dimmer.${method}: missing in response`);
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			return self.events.failure(`Kasa dimmer.${method}: ${msg}`);
		}
	}
	return result as T;
}

/** Validate a brightness level — returns an error message string, or null when OK. */
function validateBrightness(level: number): string | null {
	if (!Number.isInteger(level) || level < 1 || level > 100) {
		return `brightness must be an integer 1..100, got ${level}`;
	}
	return null;
}

/** Raw tuning-parameter fetch — shared by `parameters.get` and the fade/gentle getters. */
async function rawParameters(target: DeviceTarget): Promise<DimmerParameters | Failure> {
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
async function rawSetTime(target: DeviceTarget, method: string, arg: string, ms: number): Promise<unknown | Failure> {
	if (ms < 0) return self.events.failure(`time must be >= 0, got ${ms}`);
	const response = await self.protocol.send(target, { [NS]: { [method]: { [arg]: Math.round(ms) } } });
	return unwrap(response, method);
}

/** Raw default-behavior fetch — for verifying doubleClick / longPress writes. */
async function rawDefaultBehavior(target: DeviceTarget): Promise<{ double_click?: { mode?: string }; long_press?: { mode?: string } } | Failure> {
	const response = await self.protocol.send(target, { [NS]: { get_default_behavior: {} } });
	return unwrap(response, "get_default_behavior");
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
				const r = await rawParameters(target);
				if (self.events.isFailure(r)) return r;
				const value = r[field];
				return typeof value === "number" ? value : undefined;
			}),
		set: (target, ms, options) =>
			self.events.run(`${op}.set`, target, [ms], () => rawSetTime(target, method, arg, ms), {
				confirm: options?.confirm,
				verify: async () => {
					const r = await rawParameters(target);
					return !self.events.isFailure(r) && r[field] === Math.round(ms);
				}
			})
	};
}

/** Brightness 1..100. `set` accepts an optional fade duration (ms). */
export const brightness: DimmerApi["brightness"] = {
	get: (target) => self.events.run("dimmer.brightness.get", target, [], () => rawBrightness(target)),
	set: (target, level, durationMs, options) =>
		self.events.run(
			"dimmer.brightness.set",
			target,
			[level, durationMs],
			async () => {
				const validErr = validateBrightness(level);
				if (validErr) return self.events.failure(validErr);
				if (typeof durationMs === "number") {
					if (durationMs < 0) return self.events.failure(`durationMs must be >= 0, got ${durationMs}`);
					const response = await self.protocol.send(target, {
						[NS]: { set_dimmer_transition: { brightness: level, mode: "gentle_on_off", duration: Math.round(durationMs) } }
					});
					return unwrap(response, "set_dimmer_transition");
				}
				const response = await self.protocol.send(target, { [NS]: { set_brightness: { brightness: level } } });
				return unwrap(response, "set_brightness");
			},
			// Verify by reading brightness back. With `durationMs` the fade may still
			// be in progress — confirm may report unmatched mid-fade.
			{ confirm: options?.confirm, verify: async () => (await rawBrightness(target)) === level }
		)
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

/** Shared body for `doubleClick.set` / `longPress.set` (only the verb differs). */
function buildPressAction(op: string, method: string, behaviorKey: "double_click" | "long_press"): {
	set: (target: DeviceTarget, mode: DimmerActionMode, brightnessLevel?: number, options?: import("../../lib/types.mts").CommandOptions) => Promise<import("../../lib/types.mts").OpResult>;
} {
	return {
		set: (target, mode, brightnessLevel, options) =>
			self.events.run(
				op,
				target,
				[mode, brightnessLevel],
				async () => {
					const args: Record<string, unknown> = { mode };
					if (brightnessLevel !== undefined) {
						const err = validateBrightness(brightnessLevel);
						if (err) return self.events.failure(err);
						args.index = brightnessLevel;
					}
					const response = await self.protocol.send(target, { [NS]: { [method]: args } });
					return unwrap(response, method);
				},
				{
					confirm: options?.confirm,
					verify: async () => {
						const r = await rawDefaultBehavior(target);
						return !self.events.isFailure(r) && r[behaviorKey]?.mode === mode;
					}
				}
			)
	};
}

/** Physical double-click action. `"preset"` mode jumps to `brightness`. */
export const doubleClick: DimmerApi["doubleClick"] = buildPressAction("dimmer.doubleClick.set", "set_double_click_action", "double_click");

/** Physical long-press action. See {@link doubleClick}. */
export const longPress: DimmerApi["longPress"] = buildPressAction("dimmer.longPress.set", "set_long_press_action", "long_press");
