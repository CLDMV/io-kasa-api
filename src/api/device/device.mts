/**
 * Generic Kasa device commands that work across plugs, switches, strips, and bulbs.
 *
 * Every command runs through `self.events.run` — it resolves to an `OpResult`
 * and never throws; failures surface as `ok: false` and an `"error"` event.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, OpResult, SelfApi, SysInfo } from "../../lib/types.mts";

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

/** Fetch the device's system information. Used to detect device type, model, firmware. */
export function getSysInfo(target: DeviceTarget): Promise<OpResult<SysInfo>> {
	return self.events.run("device.getSysInfo", target, [], async () => {
		const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
		return unwrap<SysInfo>(response, "system", "get_sysinfo");
	});
}

/** Rename the device. Max ~31 chars; the device may silently truncate. */
export function setAlias(target: DeviceTarget, alias: string): Promise<OpResult> {
	return self.events.run("device.setAlias", target, [alias], async () => {
		const response = await self.protocol.send(target, { system: { set_dev_alias: { alias } } });
		return unwrap(response, "system", "set_dev_alias");
	});
}

/** Reboot the device. Default delay is 1 second (matches the official app). */
export function reboot(target: DeviceTarget, delaySec = 1): Promise<OpResult> {
	return self.events.run("device.reboot", target, [delaySec], async () => {
		const response = await self.protocol.send(target, { system: { reboot: { delay: delaySec } } });
		return unwrap(response, "system", "reboot");
	});
}

/** Turn the device's status LED on or off. TP-Link inverts this — `off=true` sends `led_off:1`. */
export function setLedOff(target: DeviceTarget, off: boolean): Promise<OpResult> {
	return self.events.run("device.setLedOff", target, [off], async () => {
		const response = await self.protocol.send(target, { system: { set_led_off: { off: off ? 1 : 0 } } });
		return unwrap(response, "system", "set_led_off");
	});
}
