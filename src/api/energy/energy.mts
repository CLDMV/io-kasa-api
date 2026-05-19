/**
 * Energy monitoring (HS110, HS300, KP115, KP125), addressed as resources:
 *   energy.realtime.get · energy.stats.daily.get · energy.stats.monthly.get
 *   energy.stats.erase()
 *
 * Older firmware reports SI units (`voltage`, `current`, ...); newer firmware
 * reports milli-units (`voltage_mv`, ...). Both pass through as-is. Every
 * command resolves to an `OpResult`.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { EnergyApi, EnergyRealtime, SelfApi } from "../../lib/types.mts";

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

/** Instantaneous voltage / current / power reading. */
export const realtime: EnergyApi["realtime"] = {
	get: (target) =>
		self.events.run("energy.realtime.get", target, [], async () => {
			const response = await self.protocol.send(target, { [NS]: { get_realtime: {} } });
			return unwrap<EnergyRealtime>(response, "get_realtime");
		})
};

/** Historical energy statistics. */
export const stats: EnergyApi["stats"] = {
	daily: {
		get: (target, year, month) =>
			self.events.run("energy.stats.daily.get", target, [year, month], async () => {
				if (month < 1 || month > 12) throw new RangeError(`month must be 1..12, got ${month}`);
				const response = await self.protocol.send(target, { [NS]: { get_daystat: { year, month } } });
				const result = unwrap<{ day_list?: Array<Record<string, number>> }>(response, "get_daystat");
				return result.day_list ?? [];
			})
	},
	monthly: {
		get: (target, year) =>
			self.events.run("energy.stats.monthly.get", target, [year], async () => {
				const response = await self.protocol.send(target, { [NS]: { get_monthstat: { year } } });
				const result = unwrap<{ month_list?: Array<Record<string, number>> }>(response, "get_monthstat");
				return result.month_list ?? [];
			})
	},
	// `confirm` is accepted but a no-op — the device exposes no clean read-back for cleared counters.
	erase: (target, _options) =>
		self.events.run("energy.stats.erase", target, [], async () => {
			const response = await self.protocol.send(target, { [NS]: { erase_emeter_stat: {} } });
			return unwrap(response, "erase_emeter_stat");
		})
};
