/**
 * Motion and ambient-light sensors on Kasa motion switches (KS200M, KS220M).
 *
 * Two device namespaces are involved:
 *   - `smartlife.iot.PIR` — the passive-infrared motion sensor
 *   - `smartlife.iot.LAS` — the light-adjustment sensor (ambient brightness),
 *     which gates motion-activated lighting so the load only triggers when dark
 *
 * On/off and (for KS220M) dimming go through the relay/`dimmer` modules; this
 * module only configures the sensors.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { AmbientLightConfig, DeviceTarget, PirConfig, SelfApi } from "../../lib/types.mts";

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
			throw new Error(`Kasa ${ns}.${method} failed: ${msg}`);
		}
	}
	return result as T;
}

// --- PIR (motion sensor) -------------------------------------------------------

/** Read the motion sensor configuration (enabled, sensitivity, cooldown, ADC range). */
export async function getPirConfig(target: DeviceTarget): Promise<PirConfig> {
	const response = await self.protocol.send(target, { [PIR]: { get_config: {} } });
	return unwrap<PirConfig>(response, PIR, "get_config");
}

/** Enable or disable the motion sensor entirely. */
export async function setPirEnabled(target: DeviceTarget, enabled: boolean): Promise<void> {
	const response = await self.protocol.send(target, { [PIR]: { set_enable: { enable: enabled ? 1 : 0 } } });
	unwrap(response, PIR, "set_enable");
}

/**
 * Select a motion-sensitivity preset by index. The device exposes a small set
 * of presets (commonly 0 = low, 1 = medium, 2 = high); `getPirConfig().array`
 * lists the ADC thresholds behind them.
 */
export async function setPirSensitivity(target: DeviceTarget, index: number): Promise<void> {
	if (!Number.isInteger(index) || index < 0) {
		throw new RangeError(`sensitivity index must be a non-negative integer, got ${index}`);
	}
	const response = await self.protocol.send(target, { [PIR]: { set_trigger_index: { index } } });
	unwrap(response, PIR, "set_trigger_index");
}

/**
 * Cooldown (ms) after a motion event before the sensor will trigger again.
 * Maps to the device's `cold_time`.
 */
export async function setPirCooldown(target: DeviceTarget, ms: number): Promise<void> {
	if (ms < 0) throw new RangeError(`cooldown must be >= 0, got ${ms}`);
	const response = await self.protocol.send(target, { [PIR]: { set_cold_time: { cold_time: Math.round(ms) } } });
	unwrap(response, PIR, "set_cold_time");
}

/** Read the raw ADC value from the motion sensor (diagnostic). */
export async function getPirAdc(target: DeviceTarget): Promise<number> {
	const response = await self.protocol.send(target, { [PIR]: { get_adc_value: {} } });
	const result = unwrap<{ value?: number; adc?: number }>(response, PIR, "get_adc_value");
	return result.value ?? result.adc ?? 0;
}

// --- LAS (ambient-light sensor) ------------------------------------------------

/** Read the ambient-light sensor configuration (enabled, darkness threshold). */
export async function getAmbientConfig(target: DeviceTarget): Promise<AmbientLightConfig> {
	const response = await self.protocol.send(target, { [LAS]: { get_config: {} } });
	return unwrap<AmbientLightConfig>(response, LAS, "get_config");
}

/**
 * Enable or disable the ambient-light gate. When enabled, motion only drives
 * the load while the room is darker than the configured threshold.
 */
export async function setAmbientEnabled(target: DeviceTarget, enabled: boolean): Promise<void> {
	const response = await self.protocol.send(target, { [LAS]: { set_enable: { enable: enabled ? 1 : 0 } } });
	unwrap(response, LAS, "set_enable");
}

/**
 * Select the darkness-threshold preset by index — how dark it must be before
 * motion is allowed to switch the load on. `getAmbientConfig().array` lists
 * the lux/ADC levels behind the presets.
 */
export async function setDarkThreshold(target: DeviceTarget, index: number): Promise<void> {
	if (!Number.isInteger(index) || index < 0) {
		throw new RangeError(`dark threshold index must be a non-negative integer, got ${index}`);
	}
	const response = await self.protocol.send(target, { [LAS]: { set_dark_index: { index } } });
	unwrap(response, LAS, "set_dark_index");
}
