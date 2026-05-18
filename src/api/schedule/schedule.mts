/**
 * Schedule (timer) rules on Kasa devices.
 *
 * The on-device schedule namespace stores rules that switch the relay/light
 * at fixed times or relative to sunrise/sunset. This module exposes the
 * common operations; full rule construction is left to callers since the
 * shape varies by device.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

const NS = "schedule";

function unwrap<T>(response: Record<string, Record<string, unknown>>, method: string): T {
	const result = response[NS]?.[method];
	if (result === undefined) throw new Error(`Kasa schedule.${method}: missing in response`);
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			throw new Error(`Kasa schedule.${method} failed: ${msg}`);
		}
	}
	return result as T;
}

/** List all schedule rules currently stored on the device. */
export async function getRules(target: DeviceTarget): Promise<unknown> {
	const response = await self.protocol.send(target, { [NS]: { get_rules: {} } });
	return unwrap(response, "get_rules");
}

/** Remove every schedule rule. */
export async function deleteAllRules(target: DeviceTarget): Promise<void> {
	const response = await self.protocol.send(target, { [NS]: { delete_all_rules: {} } });
	unwrap(response, "delete_all_rules");
}
