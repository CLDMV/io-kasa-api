/**
 * Smart-plug / smart-switch relay control.
 *
 * Works for HS100, HS103, HS105, HS110, HS200, HS210, HS300 (via child ids),
 * and the KP-series plugs that still speak the legacy port-9999 protocol.
 *
 * Every command resolves to an `OpResult` and never throws.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, OpResult, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

/** Throw on a non-zero `err_code` (caught by `run`); otherwise return the result. */
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

/** Raw relay write — no event wrapping; used inside `run`. */
async function sendRelay(target: DeviceTarget, state: 0 | 1, childIds?: string[]): Promise<unknown> {
	const command: Record<string, Record<string, unknown>> = { system: { set_relay_state: { state } } };
	if (childIds && childIds.length > 0) command.context = { child_ids: childIds };
	const response = await self.protocol.send(target, command);
	return checkError(response.system?.set_relay_state, "plug.setState");
}

/** Raw relay read — no event wrapping; used inside `run`. */
async function readState(target: DeviceTarget): Promise<0 | 1> {
	const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
	const info = response.system?.get_sysinfo as { relay_state?: 0 | 1 } | undefined;
	if (info?.relay_state === 0 || info?.relay_state === 1) return info.relay_state;
	throw new Error(`Device at ${target.host} did not report a relay_state`);
}

/** Power the outlet on. */
export function on(target: DeviceTarget): Promise<OpResult> {
	return self.events.run("plug.on", target, [], () => sendRelay(target, 1));
}

/** Power the outlet off. */
export function off(target: DeviceTarget): Promise<OpResult> {
	return self.events.run("plug.off", target, [], () => sendRelay(target, 0));
}

/** Set the outlet's relay state explicitly. */
export function setState(target: DeviceTarget, isOn: boolean): Promise<OpResult> {
	return self.events.run("plug.setState", target, [isOn], () => sendRelay(target, isOn ? 1 : 0));
}

/** Read the current relay state without modifying it. */
export function getState(target: DeviceTarget): Promise<OpResult<0 | 1>> {
	return self.events.run("plug.getState", target, [], () => readState(target));
}

/** Read the current state then flip it. `value` is the new state. */
export function toggle(target: DeviceTarget): Promise<OpResult<0 | 1>> {
	return self.events.run("plug.toggle", target, [], async () => {
		const current = await readState(target);
		const next: 0 | 1 = current === 1 ? 0 : 1;
		await sendRelay(target, next);
		return next;
	});
}

/**
 * Set state on a specific subset of outlets on a multi-outlet strip (HS300).
 * The `childIds` are the full IDs from `sysInfo.children[].id`.
 */
export function setChildState(target: DeviceTarget, childIds: string[], isOn: boolean): Promise<OpResult> {
	return self.events.run("plug.setChildState", target, [childIds, isOn], () => {
		if (childIds.length === 0) throw new Error("setChildState requires at least one child id");
		return sendRelay(target, isOn ? 1 : 0, childIds);
	});
}
