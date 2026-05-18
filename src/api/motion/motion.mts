/**
 * Motion and ambient-light sensors on Kasa motion switches (KS200M, KS220M, ES20M).
 *
 *   - `smartlife.iot.PIR` — the passive-infrared motion sensor
 *   - `smartlife.iot.LAS` — the light-adjustment sensor (ambient brightness)
 *
 * Every command resolves to an `OpResult` and never throws.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { AmbientLightConfig, DeviceTarget, OpResult, PirConfig, SelfApi } from "../../lib/types.mts";

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

// --- PIR (motion sensor) -------------------------------------------------------

/** Read the motion sensor configuration (enabled, sensitivity, cooldown, ADC range). */
export function getPirConfig(target: DeviceTarget): Promise<OpResult<PirConfig>> {
	return self.events.run("motion.getPirConfig", target, [], async () => {
		const response = await self.protocol.send(target, { [PIR]: { get_config: {} } });
		return unwrap<PirConfig>(response, PIR, "get_config");
	});
}

/** Enable or disable the motion sensor entirely. */
export function setPirEnabled(target: DeviceTarget, enabled: boolean): Promise<OpResult> {
	return self.events.run("motion.setPirEnabled", target, [enabled], async () => {
		const response = await self.protocol.send(target, { [PIR]: { set_enable: { enable: enabled ? 1 : 0 } } });
		return unwrap(response, PIR, "set_enable");
	});
}

/** Select a motion-sensitivity preset by index (commonly 0 = low, 1 = mid, 2 = high). */
export function setPirSensitivity(target: DeviceTarget, index: number): Promise<OpResult> {
	return self.events.run("motion.setPirSensitivity", target, [index], async () => {
		if (!Number.isInteger(index) || index < 0) {
			throw new RangeError(`sensitivity index must be a non-negative integer, got ${index}`);
		}
		const response = await self.protocol.send(target, { [PIR]: { set_trigger_index: { index } } });
		return unwrap(response, PIR, "set_trigger_index");
	});
}

/** Cooldown (ms) after a motion event before the sensor re-arms (`cold_time`). */
export function setPirCooldown(target: DeviceTarget, ms: number): Promise<OpResult> {
	return self.events.run("motion.setPirCooldown", target, [ms], async () => {
		if (ms < 0) throw new RangeError(`cooldown must be >= 0, got ${ms}`);
		const response = await self.protocol.send(target, { [PIR]: { set_cold_time: { cold_time: Math.round(ms) } } });
		return unwrap(response, PIR, "set_cold_time");
	});
}

/** Read the raw ADC value from the motion sensor (diagnostic). */
export function getPirAdc(target: DeviceTarget): Promise<OpResult<number>> {
	return self.events.run("motion.getPirAdc", target, [], async () => {
		const response = await self.protocol.send(target, { [PIR]: { get_adc_value: {} } });
		const result = unwrap<{ value?: number; adc?: number }>(response, PIR, "get_adc_value");
		return result.value ?? result.adc ?? 0;
	});
}

// --- LAS (ambient-light sensor) ------------------------------------------------

/** Read the ambient-light sensor configuration (enabled, darkness threshold). */
export function getAmbientConfig(target: DeviceTarget): Promise<OpResult<AmbientLightConfig>> {
	return self.events.run("motion.getAmbientConfig", target, [], async () => {
		const response = await self.protocol.send(target, { [LAS]: { get_config: {} } });
		return unwrap<AmbientLightConfig>(response, LAS, "get_config");
	});
}

/** Enable or disable the ambient-light gate (motion only drives the load while dark). */
export function setAmbientEnabled(target: DeviceTarget, enabled: boolean): Promise<OpResult> {
	return self.events.run("motion.setAmbientEnabled", target, [enabled], async () => {
		const response = await self.protocol.send(target, { [LAS]: { set_enable: { enable: enabled ? 1 : 0 } } });
		return unwrap(response, LAS, "set_enable");
	});
}

/** Select the darkness-threshold preset by index — how dark before motion may switch on. */
export function setDarkThreshold(target: DeviceTarget, index: number): Promise<OpResult> {
	return self.events.run("motion.setDarkThreshold", target, [index], async () => {
		if (!Number.isInteger(index) || index < 0) {
			throw new RangeError(`dark threshold index must be a non-negative integer, got ${index}`);
		}
		const response = await self.protocol.send(target, { [LAS]: { set_dark_index: { index } } });
		return unwrap(response, LAS, "set_dark_index");
	});
}
