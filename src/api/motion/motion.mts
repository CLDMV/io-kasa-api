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
import type { AmbientLightConfig, DeviceTarget, MotionApi, PirConfig, SelfApi } from "../../lib/types.mts";

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
