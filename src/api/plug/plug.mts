/**
 * Smart-plug / smart-switch relay control.
 *
 * Works for HS100, HS103, HS105, HS110, HS200, HS210, HS300 (via child ids),
 * and the KP-series plugs that still speak the legacy port-9999 protocol.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, SelfApi, SysInfo } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

function checkError(result: unknown, op: string): void {
  if (result && typeof result === "object" && "err_code" in result) {
    const code = (result as { err_code: number }).err_code;
    if (code !== 0) {
      const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
      throw new Error(`Kasa plug.${op} failed: ${msg}`);
    }
  }
}

async function sendRelay(target: DeviceTarget, state: 0 | 1, childIds?: string[]): Promise<void> {
  const command: Record<string, Record<string, unknown>> = {
    system: { set_relay_state: { state } }
  };
  if (childIds && childIds.length > 0) {
    command.context = { child_ids: childIds };
  }
  const response = await self.protocol.send(target, command);
  checkError(response.system?.set_relay_state, "setState");
}

/** Power the outlet on. */
export async function on(target: DeviceTarget): Promise<void> {
  await sendRelay(target, 1);
}

/** Power the outlet off. */
export async function off(target: DeviceTarget): Promise<void> {
  await sendRelay(target, 0);
}

/** Set the outlet's relay state explicitly. */
export async function setState(target: DeviceTarget, isOn: boolean): Promise<void> {
  await sendRelay(target, isOn ? 1 : 0);
}

/** Read the current relay state without modifying it. */
export async function getState(target: DeviceTarget): Promise<0 | 1> {
  const info: SysInfo = await self.device.getSysInfo(target);
  if (info.relay_state === 0 || info.relay_state === 1) return info.relay_state;
  throw new Error(`Device at ${target.host} did not report a relay_state (model ${info.model ?? "unknown"})`);
}

/** Read the current state then flip it. Returns the new state. */
export async function toggle(target: DeviceTarget): Promise<0 | 1> {
  const current = await getState(target);
  const next: 0 | 1 = current === 1 ? 0 : 1;
  await sendRelay(target, next);
  return next;
}

/**
 * Set state on a specific subset of outlets on a multi-outlet strip (HS300).
 * The `childIds` are the full IDs from `sysInfo.children[].id`.
 */
export async function setChildState(target: DeviceTarget, childIds: string[], isOn: boolean): Promise<void> {
  if (childIds.length === 0) throw new Error("setChildState requires at least one child id");
  await sendRelay(target, isOn ? 1 : 0, childIds);
}
