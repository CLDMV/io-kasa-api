/**
 * Motion (PIR) and ambient-light (LAS) sensors on motion switches
 * (KS200M, KS220M, ES20M), addressed as resources:
 *   motion.pir.{get,set} · motion.pir.sensitivity.{get,set}
 *   motion.pir.cooldown.{get,set} · motion.pir.adc.get
 *   motion.pir.status.get · motion.pir.triggered.get
 *   motion.ambient.get · motion.ambient.enabled.{get,set}
 *   motion.ambient.darkThreshold.{get,set}
 *
 * Derived getters call the same raw config fetch the parent `get` uses, so
 * each fires one event under its own path. No `throw` in this file — failures
 * return as `self.events.failure(...)` sentinels.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type {
	AmbientLightConfig,
	DeviceTarget,
	Failure,
	MotionApi,
	PirConfig,
	PirStatus,
	SelfApi
} from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;
const PIR = "smartlife.iot.PIR";
const LAS = "smartlife.iot.LAS";

function unwrap<T>(response: Record<string, Record<string, unknown>>, ns: string, method: string): T | Failure {
	const result = response[ns]?.[method];
	if (result === undefined) return self.events.failure(`Kasa ${ns}.${method}: missing in response`);
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			return self.events.failure(`Kasa ${ns}.${method}: ${msg}`);
		}
	}
	return result as T;
}

/** Validate a non-negative integer index — returns an error message string or null. */
function validateIndex(index: number, label: string): string | null {
	if (!Number.isInteger(index) || index < 0) return `${label} must be a non-negative integer, got ${index}`;
	return null;
}

/** Raw PIR config fetch — shared by `pir.get` and derived getters. */
async function rawPir(target: DeviceTarget): Promise<PirConfig | Failure> {
	const response = await self.protocol.send(target, { [PIR]: { get_config: {} } });
	return unwrap<PirConfig>(response, PIR, "get_config");
}

/** Raw LAS config fetch — shared by `ambient.get` and derived ambient getters. */
async function rawAmbient(target: DeviceTarget): Promise<AmbientLightConfig | Failure> {
	const response = await self.protocol.send(target, { [LAS]: { get_config: {} } });
	return unwrap<AmbientLightConfig>(response, LAS, "get_config");
}

/** python-kasa's calibration-free PIR motion model. */
function computePirStatus(config: PirConfig, adcValue: number): PirStatus {
	const adcMin = Number(config.min_adc ?? 0);
	const adcMax = Number(config.max_adc ?? 0);
	const adcMid = Math.floor(Math.abs(adcMax - adcMin) / 2);
	const triggerIndex = Number(config.trigger_index ?? 0);
	const threshold = Number(config.array?.[triggerIndex] ?? 0);
	const enabled = config.enable === 1;

	const offset = adcMid - adcValue;
	const divisor = offset < 0 ? adcMid - adcMin : adcMax - adcMid;
	const percent = divisor === 0 ? 0 : (offset / divisor) * 100;
	return { triggered: enabled && Math.abs(percent) > 100 - threshold, percent, adcValue };
}

/** Raw merged PIR fetch — one round-trip for `get_config` + `get_adc_value`. */
async function rawPirStatus(target: DeviceTarget): Promise<PirStatus | Failure> {
	const response = await self.protocol.send(target, { [PIR]: { get_config: {}, get_adc_value: {} } });
	const config = unwrap<PirConfig>(response, PIR, "get_config");
	if (self.events.isFailure(config)) return config;
	const adc = unwrap<{ value?: number; adc?: number }>(response, PIR, "get_adc_value");
	if (self.events.isFailure(adc)) return adc;
	return computePirStatus(config, Number(adc.value ?? adc.adc ?? 0));
}

/** Motion (PIR) sensor. `get` reads the config; `set` enables/disables. */
export const pir: MotionApi["pir"] = {
	get: (target) => self.events.run("motion.pir.get", target, [], () => rawPir(target)),
	set: (target, enabled, options) =>
		self.events.run(
			"motion.pir.set",
			target,
			[enabled],
			async () => {
				const response = await self.protocol.send(target, { [PIR]: { set_enable: { enable: enabled ? 1 : 0 } } });
				return unwrap(response, PIR, "set_enable");
			},
			{
				confirm: options?.confirm,
				verify: async () => {
					const r = await rawPir(target);
					return !self.events.isFailure(r) && r.enable === (enabled ? 1 : 0);
				}
			}
		),
	sensitivity: {
		get: (target) =>
			self.events.run("motion.pir.sensitivity.get", target, [], async () => {
				const r = await rawPir(target);
				return self.events.isFailure(r) ? r : r.trigger_index;
			}),
		set: (target, index, options) =>
			self.events.run(
				"motion.pir.sensitivity.set",
				target,
				[index],
				async () => {
					const err = validateIndex(index, "sensitivity index");
					if (err) return self.events.failure(err);
					const response = await self.protocol.send(target, { [PIR]: { set_trigger_index: { index } } });
					return unwrap(response, PIR, "set_trigger_index");
				},
				{
					confirm: options?.confirm,
					verify: async () => {
						const r = await rawPir(target);
						return !self.events.isFailure(r) && r.trigger_index === index;
					}
				}
			)
	},
	cooldown: {
		get: (target) =>
			self.events.run("motion.pir.cooldown.get", target, [], async () => {
				const r = await rawPir(target);
				return self.events.isFailure(r) ? r : r.cold_time;
			}),
		set: (target, ms, options) =>
			self.events.run(
				"motion.pir.cooldown.set",
				target,
				[ms],
				async () => {
					if (ms < 0) return self.events.failure(`cooldown must be >= 0, got ${ms}`);
					const response = await self.protocol.send(target, { [PIR]: { set_cold_time: { cold_time: Math.round(ms) } } });
					return unwrap(response, PIR, "set_cold_time");
				},
				{
					confirm: options?.confirm,
					verify: async () => {
						const r = await rawPir(target);
						return !self.events.isFailure(r) && r.cold_time === Math.round(ms);
					}
				}
			)
	},
	adc: {
		get: (target) =>
			self.events.run("motion.pir.adc.get", target, [], async () => {
				const response = await self.protocol.send(target, { [PIR]: { get_adc_value: {} } });
				const result = unwrap<{ value?: number; adc?: number }>(response, PIR, "get_adc_value");
				if (self.events.isFailure(result)) return result;
				return result.value ?? result.adc ?? 0;
			})
	},
	status: {
		get: (target) => self.events.run("motion.pir.status.get", target, [], () => rawPirStatus(target))
	},
	triggered: {
		get: (target) =>
			self.events.run("motion.pir.triggered.get", target, [], async () => {
				const r = await rawPirStatus(target);
				return self.events.isFailure(r) ? r : r.triggered;
			})
	}
};

/** Ambient-light (LAS) sensor. `get` reads the config; sub-resources gate behaviour. */
export const ambient: MotionApi["ambient"] = {
	get: (target) => self.events.run("motion.ambient.get", target, [], () => rawAmbient(target)),
	enabled: {
		get: (target) =>
			self.events.run("motion.ambient.enabled.get", target, [], async () => {
				const r = await rawAmbient(target);
				return self.events.isFailure(r) ? r : r.enable === 1;
			}),
		set: (target, enabled, options) =>
			self.events.run(
				"motion.ambient.enabled.set",
				target,
				[enabled],
				async () => {
					const response = await self.protocol.send(target, { [LAS]: { set_enable: { enable: enabled ? 1 : 0 } } });
					return unwrap(response, LAS, "set_enable");
				},
				{
					confirm: options?.confirm,
					verify: async () => {
						const r = await rawAmbient(target);
						return !self.events.isFailure(r) && r.enable === (enabled ? 1 : 0);
					}
				}
			)
	},
	darkThreshold: {
		get: (target) =>
			self.events.run("motion.ambient.darkThreshold.get", target, [], async () => {
				const r = await rawAmbient(target);
				return self.events.isFailure(r) ? r : r.dark_index;
			}),
		set: (target, index, options) =>
			self.events.run(
				"motion.ambient.darkThreshold.set",
				target,
				[index],
				async () => {
					const err = validateIndex(index, "dark threshold index");
					if (err) return self.events.failure(err);
					const response = await self.protocol.send(target, { [LAS]: { set_dark_index: { index } } });
					return unwrap(response, LAS, "set_dark_index");
				},
				{
					confirm: options?.confirm,
					verify: async () => {
						const r = await rawAmbient(target);
						return !self.events.isFailure(r) && r.dark_index === index;
					}
				}
			)
	}
};
