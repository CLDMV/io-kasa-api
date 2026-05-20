/**
 * Wall light-switch control (HS200, HS210, HS220, HS230, KS200M, KS220M, ES20M):
 *   switch.power.{get,set} · switch.on() · switch.off() · switch.toggle()
 *
 * A Kasa wall switch toggles the same `system.set_relay_state` relay as a plug;
 * the relay logic is inlined so each command emits its own `switch.*` event.
 * `power.set(bool)` routes to `on`/`off`. No `throw` in this file — failures
 * are returned as `self.events.failure(...)` sentinels.
 *
 * Multi-outlet support mirrors `plug.mts` for symmetry: a `target.child`
 * selects a single outlet; a strip target without `target.child` broadcasts
 * to every outlet. In practice wall switches don't ship multi-outlet today,
 * but the contract stays consistent so a future device or aliasing setup
 * doesn't trip on `switch.on(strip)` vs `plug.on(strip)`.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { CommandOptions, DeviceTarget, Failure, OpResult, SelfApi, SwitchApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

/** Check an err_code result; returns the result on success or a Failure sentinel. */
function checkError(result: unknown, op: string): unknown | Failure {
	if (result && typeof result === "object" && "err_code" in result) {
		const code = (result as { err_code: number }).err_code;
		if (code !== 0) {
			const msg = (result as { err_msg?: string }).err_msg ?? `err_code ${code}`;
			return self.events.failure(`Kasa ${op}: ${msg}`);
		}
	}
	return result;
}

type SysChild = { id: string; alias: string; state: 0 | 1 };

async function readSysInfo(target: DeviceTarget): Promise<{ relay_state?: 0 | 1; children?: SysChild[] } | Failure> {
	const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
	const info = response.system?.get_sysinfo as { relay_state?: 0 | 1; children?: SysChild[] } | undefined;
	if (!info) return self.events.failure(`Device at ${target.host} returned no sysinfo`);
	return info;
}

async function sendRelay(target: DeviceTarget, state: 0 | 1, childIds?: string[]): Promise<unknown | Failure> {
	const command: Record<string, Record<string, unknown>> = { system: { set_relay_state: { state } } };
	if (childIds && childIds.length > 0) command.context = { child_ids: childIds };
	const response = await self.protocol.send(target, command);
	return checkError(response.system?.set_relay_state, "switch relay");
}

/** Decide child IDs for an on/off call — see plug.mts for the parallel logic.
 * Pre-read failures are non-fatal — we fall back to the bare write so single-
 * outlet devices (and test fakes that only answer set_relay_state) keep working. */
async function routeChildIds(target: DeviceTarget): Promise<{ ids: string[] | undefined }> {
	if (target.child) return { ids: [target.child] };
	const info = await readSysInfo(target);
	if (self.events.isFailure(info)) return { ids: undefined };
	const kids = info.children;
	if (kids && kids.length > 0) return { ids: kids.map((c) => c.id) };
	return { ids: undefined };
}

async function verifyState(target: DeviceTarget, want: 0 | 1, ids: string[] | undefined): Promise<boolean> {
	const info = await readSysInfo(target);
	if (self.events.isFailure(info)) return false;
	if (ids && ids.length > 0) {
		const kids = info.children ?? [];
		return ids.every((id) => kids.find((c) => c.id === id)?.state === want);
	}
	return info.relay_state === want;
}

async function readState(target: DeviceTarget): Promise<(0 | 1) | Failure> {
	const info = await readSysInfo(target);
	if (self.events.isFailure(info)) return info;
	if (info.relay_state === 0 || info.relay_state === 1) return info.relay_state;
	const kids = info.children;
	if (kids && kids.length > 0) return kids.some((c) => c.state === 1) ? 1 : 0;
	return self.events.failure(`Device at ${target.host} did not report a relay_state`);
}

/** Turn the switch on. With `target.child`: just that outlet. On a strip with no child: all outlets. */
export function on(target: DeviceTarget, options?: CommandOptions): Promise<OpResult> {
	return self.events.run(
		"switch.on",
		target,
		[],
		async () => {
			const route = await routeChildIds(target);
			return sendRelay(target, 1, route.ids);
		},
		{
			confirm: options?.confirm,
			verify: async () => {
				if (target.child) return verifyState(target, 1, [target.child]);
				const info = await readSysInfo(target);
				if (self.events.isFailure(info)) return false;
				const kids = info.children;
				if (kids && kids.length > 0) return verifyState(target, 1, kids.map((c) => c.id));
				return info.relay_state === 1;
			}
		}
	);
}

/** Turn the switch off. See {@link on} for child / strip semantics. */
export function off(target: DeviceTarget, options?: CommandOptions): Promise<OpResult> {
	return self.events.run(
		"switch.off",
		target,
		[],
		async () => {
			const route = await routeChildIds(target);
			return sendRelay(target, 0, route.ids);
		},
		{
			confirm: options?.confirm,
			verify: async () => {
				if (target.child) return verifyState(target, 0, [target.child]);
				const info = await readSysInfo(target);
				if (self.events.isFailure(info)) return false;
				const kids = info.children;
				if (kids && kids.length > 0) return verifyState(target, 0, kids.map((c) => c.id));
				return info.relay_state === 0;
			}
		}
	);
}

/** Read the current state then flip it. See plug.toggle for the child / strip rules. */
export function toggle(target: DeviceTarget, options?: CommandOptions): Promise<OpResult<0 | 1>> {
	let next: 0 | 1 = 0;
	let writtenIds: string[] | undefined;
	return self.events.run(
		"switch.toggle",
		target,
		[],
		async () => {
			const info = await readSysInfo(target);
			if (self.events.isFailure(info)) return info;
			const kids = info.children;
			if (target.child) {
				const child = kids?.find((c) => c.id === target.child);
				if (!child) return self.events.failure(`child ${target.child} not found on ${target.host}`);
				next = child.state === 1 ? 0 : 1;
				writtenIds = [target.child];
			} else if (kids && kids.length > 0) {
				next = kids.some((c) => c.state === 1) ? 0 : 1;
				writtenIds = kids.map((c) => c.id);
			} else {
				if (info.relay_state !== 0 && info.relay_state !== 1) {
					return self.events.failure(`Device at ${target.host} did not report a relay_state`);
				}
				next = info.relay_state === 1 ? 0 : 1;
				writtenIds = undefined;
			}
			const written = await sendRelay(target, next, writtenIds);
			if (self.events.isFailure(written)) return written;
			return next;
		},
		{ confirm: options?.confirm, verify: () => verifyState(target, next, writtenIds) }
	);
}

/** Relay power state. `set` routes to `on`/`off` (inherits the child semantics). */
export const power: SwitchApi["power"] = {
	get: (target) => self.events.run("switch.power.get", target, [], () => readState(target)),
	set: (target, isOn, options) => (isOn ? on(target, options) : off(target, options))
};
