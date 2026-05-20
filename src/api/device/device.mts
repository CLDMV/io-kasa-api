/**
 * Generic Kasa device commands, addressed as nested resources:
 *   device.info.get · device.alias.{get,set} · device.led.{get,set} · device.reboot()
 *
 * Every command runs through `self.events.run` — it resolves to an `OpResult`
 * and never throws; failures are signalled via `self.events.failure(...)`
 * sentinels returned from the work callback (no `throw` in this file).
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { CommandOptions, DeviceApi, DeviceTarget, Failure, OpResult, SelfApi, SysInfo } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

/** Unwrap a `namespace.method` result; returns the value or a `Failure` sentinel. */
function unwrap<T>(response: Record<string, Record<string, unknown>>, namespace: string, method: string): T | Failure {
	const ns = response[namespace];
	if (!ns) return self.events.failure(`Kasa response missing namespace "${namespace}"`);
	const result = ns[method];
	if (result === undefined) return self.events.failure(`Kasa response missing "${namespace}.${method}"`);
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			return self.events.failure(`Kasa ${namespace}.${method}: ${msg}`);
		}
	}
	return result as T;
}

/** Raw sysinfo fetch — no event wrapping. Shared by `info.get` and derived getters. */
async function rawSysInfo(target: DeviceTarget): Promise<SysInfo | Failure> {
	const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
	return unwrap<SysInfo>(response, "system", "get_sysinfo");
}

/** Full device system information. */
export const info: DeviceApi["info"] = {
	get: (target) => self.events.run("device.info.get", target, [], () => rawSysInfo(target))
};

/** Device alias / display name. Pass `options.child` to rename a child outlet. */
export const alias: DeviceApi["alias"] = {
	get: (target) =>
		self.events.run("device.alias.get", target, [], async () => {
			const r = await rawSysInfo(target);
			return self.events.isFailure(r) ? r : r.alias;
		}),
	set: (target, value, options) =>
		self.events.run(
			"device.alias.set",
			target,
			options?.child ? [value, { child: options.child }] : [value],
			async () => {
				// Child rename — wrap the command in a context.child_ids block so
				// the device routes the rename to that outlet (HS300 / KP200).
				const command: Record<string, Record<string, unknown>> = { system: { set_dev_alias: { alias: value } } };
				if (options?.child) command.context = { child_ids: [options.child] };
				const response = await self.protocol.send(target, command);
				return unwrap(response, "system", "set_dev_alias");
			},
			{
				confirm: options?.confirm,
				verify: async () => {
					const r = await rawSysInfo(target);
					if (self.events.isFailure(r)) return false;
					if (options?.child) {
						const kids = r.children ?? [];
						return kids.find((c) => c.id === options.child)?.alias === value;
					}
					return r.alias === value;
				}
			}
		)
};

/** Status LED. `get`/`set` are in terms of LED-on; the device stores the inverse (`led_off`). */
export const led: DeviceApi["led"] = {
	get: (target) =>
		self.events.run("device.led.get", target, [], async () => {
			const r = await rawSysInfo(target);
			return self.events.isFailure(r) ? r : r.led_off !== 1;
		}),
	set: (target, on, options) =>
		self.events.run(
			"device.led.set",
			target,
			[on],
			async () => {
				const response = await self.protocol.send(target, { system: { set_led_off: { off: on ? 0 : 1 } } });
				return unwrap(response, "system", "set_led_off");
			},
			{
				confirm: options?.confirm,
				verify: async () => {
					const r = await rawSysInfo(target);
					return !self.events.isFailure(r) && r.led_off === (on ? 0 : 1);
				}
			}
		)
};

/**
 * Reboot the device. Default delay is 1 second (matches the official app).
 * `confirm` is a no-op here — the device is rebooting and can't read-back.
 */
export function reboot(target: DeviceTarget, delaySec = 1, _options?: CommandOptions): Promise<OpResult> {
	return self.events.run("device.reboot", target, [delaySec], async () => {
		const response = await self.protocol.send(target, { system: { reboot: { delay: delaySec } } });
		return unwrap(response, "system", "reboot");
	});
}
