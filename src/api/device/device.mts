/**
 * Generic Kasa device commands, addressed as nested resources:
 *   device.info.get · device.alias.{get,set} · device.led.{get,set} · device.reboot()
 *
 * Every command runs through `self.events.run` — it resolves to an `OpResult`
 * and never throws; failures surface as `ok: false` and an `"error"` event.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceApi, DeviceTarget, OpResult, SelfApi, SysInfo } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

/** Unwrap a `namespace.method` result; throws on a non-zero `err_code` (caught by `run`). */
function unwrap<T>(response: Record<string, Record<string, unknown>>, namespace: string, method: string): T {
	const ns = response[namespace];
	if (!ns) throw new Error(`Kasa response missing namespace "${namespace}"`);
	const result = ns[method];
	if (result === undefined) throw new Error(`Kasa response missing "${namespace}.${method}"`);
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			throw new Error(`Kasa ${namespace}.${method}: ${msg}`);
		}
	}
	return result as T;
}

/** Raw sysinfo fetch — no event wrapping. Shared by `info.get` and the derived getters. */
async function rawSysInfo(target: DeviceTarget): Promise<SysInfo> {
	const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
	return unwrap<SysInfo>(response, "system", "get_sysinfo");
}

/** Full device system information. */
export const info: DeviceApi["info"] = {
	get: (target) => self.events.run("device.info.get", target, [], () => rawSysInfo(target))
};

/** Device alias / display name. */
export const alias: DeviceApi["alias"] = {
	get: (target) => self.events.run("device.alias.get", target, [], async () => (await rawSysInfo(target)).alias),
	set: (target, value) =>
		self.events.run("device.alias.set", target, [value], async () => {
			const response = await self.protocol.send(target, { system: { set_dev_alias: { alias: value } } });
			return unwrap(response, "system", "set_dev_alias");
		})
};

/** Status LED. `get`/`set` are in terms of LED-on; the device stores the inverse (`led_off`). */
export const led: DeviceApi["led"] = {
	get: (target) =>
		self.events.run("device.led.get", target, [], async () => (await rawSysInfo(target)).led_off !== 1),
	set: (target, on) =>
		self.events.run("device.led.set", target, [on], async () => {
			const response = await self.protocol.send(target, { system: { set_led_off: { off: on ? 0 : 1 } } });
			return unwrap(response, "system", "set_led_off");
		})
};

/** Reboot the device. Default delay is 1 second (matches the official app). */
export function reboot(target: DeviceTarget, delaySec = 1): Promise<OpResult> {
	return self.events.run("device.reboot", target, [delaySec], async () => {
		const response = await self.protocol.send(target, { system: { reboot: { delay: delaySec } } });
		return unwrap(response, "system", "reboot");
	});
}
