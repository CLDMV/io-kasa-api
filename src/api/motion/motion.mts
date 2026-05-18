/**
 * Motion (PIR) and ambient-light (LAS) sensors on motion switches
 * (KS200M, KS220M, ES20M), addressed as resources:
 *   motion.pir.{get,set} · motion.pir.sensitivity.{get,set}
 *   motion.pir.cooldown.{get,set} · motion.pir.adc.get
 *   motion.ambient.get · motion.ambient.enabled.{get,set}
 *   motion.ambient.darkThreshold.{get,set}
 *
 * Derived getters call the same raw config fetch the parent `get` uses, so
 * each fires one event under its own path. Every command yields an `OpResult`.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { AmbientLightConfig, DeviceTarget, MotionApi, PirConfig, PirStatus, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;
const PIR = "smartlife.iot.PIR";
const LAS = "smartlife.iot.LAS";

function unwrap<T>(response: Record<string, Record<string, unknown>>, ns: string, method: string): T {
	const result = response[ns]?.[method];
	if (result === undefined) throw new Error(`Kasa ${ns}.${method}: missing in response`);
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			throw new Error(`Kasa ${ns}.${method}: ${msg}`);
		}
	}
	return result as T;
}

/** Raw PIR config fetch — shared by `pir.get` and the derived PIR getters. */
async function rawPir(target: DeviceTarget): Promise<PirConfig> {
	const response = await self.protocol.send(target, { [PIR]: { get_config: {} } });
	return unwrap<PirConfig>(response, PIR, "get_config");
}

/**
 * Compute live motion state from a PIR config + ADC reading.
 *
 * python-kasa's calibration-free model (kasa/iot/modules/motion.py): the
 * reference is the fixed midpoint of the device's declared ADC range —
 * a hardware constant, not a learned baseline — and the trigger bar is the
 * device's own configured sensitivity (`array[trigger_index]`). The PIR
 * element is AC-coupled, so it always rests at midpoint regardless of
 * ambient light; motion swings it away.
 */
function computePirStatus(config: PirConfig, adcValue: number): PirStatus {
	const adcMin = Number(config.min_adc ?? 0);
	const adcMax = Number(config.max_adc ?? 0);
	const adcMid = Math.floor(Math.abs(adcMax - adcMin) / 2);
	const triggerIndex = Number(config.trigger_index ?? 0);
	const threshold = Number(config.array?.[triggerIndex] ?? 0);
	const enabled = config.enable === 1;

	// Signed offset from midpoint, normalised to ±100% of the available swing.
	const offset = adcMid - adcValue;
	const divisor = offset < 0 ? adcMid - adcMin : adcMax - adcMid;
	const percent = divisor === 0 ? 0 : (offset / divisor) * 100;
	return { triggered: enabled && Math.abs(percent) > 100 - threshold, percent, adcValue };
}

/** Raw merged PIR fetch — one round-trip for `get_config` + `get_adc_value`, then `computePirStatus`. */
async function rawPirStatus(target: DeviceTarget): Promise<PirStatus> {
	const response = await self.protocol.send(target, { [PIR]: { get_config: {}, get_adc_value: {} } });
	const config = unwrap<PirConfig>(response, PIR, "get_config");
	const adc = unwrap<{ value?: number; adc?: number }>(response, PIR, "get_adc_value");
	return computePirStatus(config, Number(adc.value ?? adc.adc ?? 0));
}

/** Raw LAS config fetch — shared by `ambient.get` and the derived ambient getters. */
async function rawAmbient(target: DeviceTarget): Promise<AmbientLightConfig> {
	const response = await self.protocol.send(target, { [LAS]: { get_config: {} } });
	return unwrap<AmbientLightConfig>(response, LAS, "get_config");
}

function assertIndex(index: number, label: string): void {
	if (!Number.isInteger(index) || index < 0) {
		throw new RangeError(`${label} must be a non-negative integer, got ${index}`);
	}
}

/** Motion (PIR) sensor. `get` reads the config; `set` enables/disables. */
export const pir: MotionApi["pir"] = {
	get: (target) => self.events.run("motion.pir.get", target, [], () => rawPir(target)),
	set: (target, enabled) =>
		self.events.run("motion.pir.set", target, [enabled], async () => {
			const response = await self.protocol.send(target, { [PIR]: { set_enable: { enable: enabled ? 1 : 0 } } });
			return unwrap(response, PIR, "set_enable");
		}),
	sensitivity: {
		get: (target) => self.events.run("motion.pir.sensitivity.get", target, [], async () => (await rawPir(target)).trigger_index),
		set: (target, index) =>
			self.events.run("motion.pir.sensitivity.set", target, [index], async () => {
				assertIndex(index, "sensitivity index");
				const response = await self.protocol.send(target, { [PIR]: { set_trigger_index: { index } } });
				return unwrap(response, PIR, "set_trigger_index");
			})
	},
	cooldown: {
		get: (target) => self.events.run("motion.pir.cooldown.get", target, [], async () => (await rawPir(target)).cold_time),
		set: (target, ms) =>
			self.events.run("motion.pir.cooldown.set", target, [ms], async () => {
				if (ms < 0) throw new RangeError(`cooldown must be >= 0, got ${ms}`);
				const response = await self.protocol.send(target, { [PIR]: { set_cold_time: { cold_time: Math.round(ms) } } });
				return unwrap(response, PIR, "set_cold_time");
			})
	},
	adc: {
		get: (target) =>
			self.events.run("motion.pir.adc.get", target, [], async () => {
				const response = await self.protocol.send(target, { [PIR]: { get_adc_value: {} } });
				const result = unwrap<{ value?: number; adc?: number }>(response, PIR, "get_adc_value");
				return result.value ?? result.adc ?? 0;
			})
	},
	status: {
		get: (target) => self.events.run("motion.pir.status.get", target, [], () => rawPirStatus(target))
	},
	triggered: {
		get: (target) => self.events.run("motion.pir.triggered.get", target, [], async () => (await rawPirStatus(target)).triggered)
	}
};

/** Ambient-light (LAS) sensor. `get` reads the config; sub-resources gate behaviour. */
export const ambient: MotionApi["ambient"] = {
	get: (target) => self.events.run("motion.ambient.get", target, [], () => rawAmbient(target)),
	enabled: {
		get: (target) => self.events.run("motion.ambient.enabled.get", target, [], async () => (await rawAmbient(target)).enable === 1),
		set: (target, enabled) =>
			self.events.run("motion.ambient.enabled.set", target, [enabled], async () => {
				const response = await self.protocol.send(target, { [LAS]: { set_enable: { enable: enabled ? 1 : 0 } } });
				return unwrap(response, LAS, "set_enable");
			})
	},
	darkThreshold: {
		get: (target) => self.events.run("motion.ambient.darkThreshold.get", target, [], async () => (await rawAmbient(target)).dark_index),
		set: (target, index) =>
			self.events.run("motion.ambient.darkThreshold.set", target, [index], async () => {
				assertIndex(index, "dark threshold index");
				const response = await self.protocol.send(target, { [LAS]: { set_dark_index: { index } } });
				return unwrap(response, LAS, "set_dark_index");
			})
	}
};
