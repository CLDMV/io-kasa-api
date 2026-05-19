/**
 * On-device schedule (timer) rules: `schedule.rules.get` · `schedule.rules.clear()`.
 *
 * The schedule namespace stores rules that switch the relay/light at fixed
 * times or relative to sunrise/sunset. Rule construction varies by device and
 * is left to callers. No `throw` in this file — failures return as
 * `self.events.failure(...)` sentinels.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { Failure, ScheduleApi, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;
const NS = "schedule";

function unwrap<T>(response: Record<string, Record<string, unknown>>, method: string): T | Failure {
	const result = response[NS]?.[method];
	if (result === undefined) return self.events.failure(`Kasa schedule.${method}: missing in response`);
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			return self.events.failure(`Kasa schedule.${method}: ${msg}`);
		}
	}
	return result as T;
}

/** Schedule rules stored on the device. */
export const rules: ScheduleApi["rules"] = {
	get: (target) =>
		self.events.run("schedule.rules.get", target, [], async () => {
			const response = await self.protocol.send(target, { [NS]: { get_rules: {} } });
			return unwrap(response, "get_rules");
		}),
	clear: (target, options) =>
		self.events.run(
			"schedule.rules.clear",
			target,
			[],
			async () => {
				const response = await self.protocol.send(target, { [NS]: { delete_all_rules: {} } });
				return unwrap(response, "delete_all_rules");
			},
			{
				confirm: options?.confirm,
				verify: async () => {
					const response = await self.protocol.send(target, { [NS]: { get_rules: {} } });
					const result = (response[NS]?.get_rules ?? {}) as { rule_list?: unknown[] };
					return (result.rule_list?.length ?? 0) === 0;
				}
			}
		)
};
