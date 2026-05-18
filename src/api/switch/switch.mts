/**
 * Wall light-switch control (HS200, HS210, HS220, HS230, KS200M, KS220M).
 *
 * At the protocol level a Kasa wall switch is identical to a plug — it toggles
 * a `system.set_relay_state` relay — so this module is a thin, intention-revealing
 * alias over `plug`. Reach for `api.switch.*` when the device is a switch; the
 * behaviour is the same as `api.plug.*`.
 *
 * Capability layering for switches:
 *   - on/off/toggle .......... here (or `plug`)
 *   - brightness (dimmers) ... `dimmer`
 *   - motion/ambient sensors . `motion`
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

/** Turn the switch on. */
export async function on(target: DeviceTarget): Promise<void> {
	await self.plug.on(target);
}

/** Turn the switch off. */
export async function off(target: DeviceTarget): Promise<void> {
	await self.plug.off(target);
}

/** Set the switch state explicitly. */
export async function setState(target: DeviceTarget, isOn: boolean): Promise<void> {
	await self.plug.setState(target, isOn);
}

/** Read the current switch state without modifying it. */
export async function getState(target: DeviceTarget): Promise<0 | 1> {
	return await self.plug.getState(target);
}

/** Read the current state then flip it. Returns the new state. */
export async function toggle(target: DeviceTarget): Promise<0 | 1> {
	return await self.plug.toggle(target);
}
