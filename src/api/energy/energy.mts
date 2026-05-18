/**
 * Energy monitoring for devices with an integrated emeter (HS110, HS300, KP115, KP125, etc).
 *
 * Older firmware reports SI units (`voltage`, `current`, `power`, `total`);
 * newer firmware reports milli-units (`voltage_mv`, `current_ma`, `power_mw`, `total_wh`).
 * Both are surfaced as-is — callers normalise if they want a single unit.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { DeviceTarget, EnergyRealtime, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

const NS = "emeter";

function unwrap<T>(response: Record<string, Record<string, unknown>>, method: string): T {
  const result = response[NS]?.[method];
  if (!result) throw new Error(`Kasa emeter.${method}: missing in response`);
  if (typeof result === "object" && "err_code" in result) {
    const code = (result as { err_code: number }).err_code;
    if (code !== 0) {
      const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
      throw new Error(`Kasa emeter.${method} failed: ${msg}`);
    }
  }
  return result as T;
}

/** Instantaneous voltage / current / power / cumulative-total reading. */
export async function getRealtime(target: DeviceTarget): Promise<EnergyRealtime> {
  const response = await self.protocol.send(target, { [NS]: { get_realtime: {} } });
  return unwrap<EnergyRealtime>(response, "get_realtime");
}

/** Per-day energy stats for a calendar month. */
export async function getDayStats(
  target: DeviceTarget,
  year: number,
  month: number
): Promise<Array<Record<string, number>>> {
  if (month < 1 || month > 12) throw new RangeError(`month must be 1..12, got ${month}`);
  const response = await self.protocol.send(target, {
    [NS]: { get_daystat: { year, month } }
  });
  const result = unwrap<{ day_list?: Array<Record<string, number>> }>(response, "get_daystat");
  return result.day_list ?? [];
}

/** Per-month energy stats for a year. */
export async function getMonthStats(
  target: DeviceTarget,
  year: number
): Promise<Array<Record<string, number>>> {
  const response = await self.protocol.send(target, {
    [NS]: { get_monthstat: { year } }
  });
  const result = unwrap<{ month_list?: Array<Record<string, number>> }>(response, "get_monthstat");
  return result.month_list ?? [];
}

/** Wipe the device's cumulative energy counters. Irreversible. */
export async function eraseStats(target: DeviceTarget): Promise<void> {
  const response = await self.protocol.send(target, { [NS]: { erase_emeter_stat: {} } });
  unwrap(response, "erase_emeter_stat");
}
