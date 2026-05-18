/**
 * Energy monitoring for devices with an integrated emeter (HS110, HS300, KP115, KP125, etc).
 *
 * Older firmware reports SI units (`voltage`, `current`, `power`, `total`);
 * newer firmware reports milli-units (`voltage_mv`, `current_ma`, `power_mw`,
 * `total_wh`). Both are surfaced as-is.
 *
 * Every command resolves to an `OpResult` and never throws.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, EnergyRealtime, OpResult, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;
const NS = "emeter";

function unwrap<T>(response: Record<string, Record<string, unknown>>, method: string): T {
	const result = response[NS]?.[method];
	if (result === undefined) throw new Error(`Kasa emeter.${method}: missing in response`);
	if (typeof result === "object" && result !== null && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			throw new Error(`Kasa emeter.${method}: ${msg}`);
		}
	}
	return result as T;
}

/** Instantaneous voltage / current / power / cumulative-total reading. */
export function getRealtime(target: DeviceTarget): Promise<OpResult<EnergyRealtime>> {
	return self.events.run("energy.getRealtime", target, [], async () => {
		const response = await self.protocol.send(target, { [NS]: { get_realtime: {} } });
		return unwrap<EnergyRealtime>(response, "get_realtime");
	});
}

/** Per-day energy stats for a calendar month. */
export function getDayStats(
	target: DeviceTarget,
	year: number,
	month: number
): Promise<OpResult<Array<Record<string, number>>>> {
	return self.events.run("energy.getDayStats", target, [year, month], async () => {
		if (month < 1 || month > 12) throw new RangeError(`month must be 1..12, got ${month}`);
		const response = await self.protocol.send(target, { [NS]: { get_daystat: { year, month } } });
		const result = unwrap<{ day_list?: Array<Record<string, number>> }>(response, "get_daystat");
		return result.day_list ?? [];
	});
}

/** Per-month energy stats for a year. */
export function getMonthStats(
	target: DeviceTarget,
	year: number
): Promise<OpResult<Array<Record<string, number>>>> {
	return self.events.run("energy.getMonthStats", target, [year], async () => {
		const response = await self.protocol.send(target, { [NS]: { get_monthstat: { year } } });
		const result = unwrap<{ month_list?: Array<Record<string, number>> }>(response, "get_monthstat");
		return result.month_list ?? [];
	});
}

/** Wipe the device's cumulative energy counters. Irreversible. */
export function eraseStats(target: DeviceTarget): Promise<OpResult> {
	return self.events.run("energy.eraseStats", target, [], async () => {
		const response = await self.protocol.send(target, { [NS]: { erase_emeter_stat: {} } });
		return unwrap(response, "erase_emeter_stat");
	});
}
