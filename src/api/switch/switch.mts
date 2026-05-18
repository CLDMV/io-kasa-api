/**
 * Wall light-switch control (HS200, HS210, HS220, HS230, KS200M, KS220M, ES20M).
 *
 * A Kasa wall switch toggles the same `system.set_relay_state` relay as a plug;
 * this module is the intention-revealing surface for switches. The relay logic
 * is inlined (rather than delegating to `plug`) so each switch command emits
 * its own `switch.*` event instead of a nested `plug.*` one.
 *
 * Capability layering: on/off here (or `plug`) · brightness → `dimmer` ·
 * motion/ambient sensors → `motion`.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, OpResult, SelfApi } from "../../lib/types.mts";

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
	return checkError(response.system?.set_relay_state, "switch.setState");
}

async function readState(target: DeviceTarget): Promise<0 | 1> {
	const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
	const info = response.system?.get_sysinfo as { relay_state?: 0 | 1 } | undefined;
	if (info?.relay_state === 0 || info?.relay_state === 1) return info.relay_state;
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

/** Set the switch state explicitly. */
export function setState(target: DeviceTarget, isOn: boolean): Promise<OpResult> {
	return self.events.run("switch.setState", target, [isOn], () => sendRelay(target, isOn ? 1 : 0));
}

/** Read the current switch state without modifying it. */
export function getState(target: DeviceTarget): Promise<OpResult<0 | 1>> {
	return self.events.run("switch.getState", target, [], () => readState(target));
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
