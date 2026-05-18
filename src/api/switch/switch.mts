/**
 * Wall light-switch control (HS200, HS210, HS220, HS230, KS200M, KS220M, ES20M):
 *   switch.power.{get,set} · switch.on() · switch.off() · switch.toggle()
 *
 * A Kasa wall switch toggles the same `system.set_relay_state` relay as a plug;
 * the relay logic is inlined so each command emits its own `switch.*` event.
 * `power.set(bool)` routes to `on`/`off`.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, OpResult, SelfApi, SwitchApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

function checkError(result: unknown, op: string): unknown {
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			throw new Error(`Kasa ${op}: ${msg}`);
		}
	}
	return result;
}

async function sendRelay(target: DeviceTarget, state: 0 | 1): Promise<unknown> {
	const response = await self.protocol.send(target, { system: { set_relay_state: { state } } });
	return checkError(response.system?.set_relay_state, "switch relay");
}

async function readState(target: DeviceTarget): Promise<0 | 1> {
	const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
	const sysInfo = response.system?.get_sysinfo as { relay_state?: 0 | 1 } | undefined;
	if (sysInfo?.relay_state === 0 || sysInfo?.relay_state === 1) return sysInfo.relay_state;
	throw new Error(`Device at ${target.host} did not report a relay_state`);
}

/** Turn the switch on. */
export function on(target: DeviceTarget): Promise<OpResult> {
	return self.events.run("switch.on", target, [], () => sendRelay(target, 1));
}

/** Turn the switch off. */
export function off(target: DeviceTarget): Promise<OpResult> {
	return self.events.run("switch.off", target, [], () => sendRelay(target, 0));
}

/** Read the current state then flip it. `value` is the new state. */
export function toggle(target: DeviceTarget): Promise<OpResult<0 | 1>> {
	return self.events.run("switch.toggle", target, [], async () => {
		const current = await readState(target);
		const next: 0 | 1 = current === 1 ? 0 : 1;
		await sendRelay(target, next);
		return next;
	});
}

/** Relay power state. `set` routes to `on`/`off`. */
export const power: SwitchApi["power"] = {
	get: (target) => self.events.run("switch.power.get", target, [], () => readState(target)),
	set: (target, isOn) => (isOn ? on(target) : off(target))
};
