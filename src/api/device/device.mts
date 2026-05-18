/**
 * Generic Kasa device commands that work across plugs, switches, strips, and bulbs.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, SelfApi, SysInfo } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

function unwrap<T>(response: Record<string, Record<string, unknown>>, namespace: string, method: string): T {
	const ns = response[namespace];
	if (!ns) throw new Error(`Kasa response missing namespace "${namespace}": ${JSON.stringify(response)}`);
	const result = ns[method];
	if (result === undefined) throw new Error(`Kasa response missing method "${method}" in "${namespace}"`);
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			throw new Error(`Kasa device error in ${namespace}.${method}: ${msg}`);
		}
	}
	return result as T;
}

/** Fetch the device's system information. Used to detect device type, model, firmware. */
export async function getSysInfo(target: DeviceTarget): Promise<SysInfo> {
	const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
	return unwrap<SysInfo>(response, "system", "get_sysinfo");
}

/** Rename the device. Max ~31 chars; the device may silently truncate. */
export async function setAlias(target: DeviceTarget, alias: string): Promise<void> {
	const response = await self.protocol.send(target, { system: { set_dev_alias: { alias } } });
	unwrap(response, "system", "set_dev_alias");
}

/** Reboot the device. Default delay is 1 second (matches the official app). */
export async function reboot(target: DeviceTarget, delaySec = 1): Promise<void> {
	const response = await self.protocol.send(target, { system: { reboot: { delay: delaySec } } });
	unwrap(response, "system", "reboot");
}

/** Turn the device's status LED on or off. TP-Link inverts this — `off=true` sends `led_off:1`. */
export async function setLedOff(target: DeviceTarget, off: boolean): Promise<void> {
	const response = await self.protocol.send(target, {
		system: { set_led_off: { off: off ? 1 : 0 } }
	});
	unwrap(response, "system", "set_led_off");
}
