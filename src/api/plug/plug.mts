/**
 * Smart-plug relay control, addressed as nested resources:
 *   plug.power.{get,set} · plug.on() · plug.off() · plug.toggle() · plug.children.set()
 *
 * `power.set(bool)` is a thin router to `on`/`off` — the real op (and event)
 * is `plug.on` / `plug.off`. No `throw` in this file; failures return as
 * `self.events.failure(...)` sentinels that `run()` converts to `ok: false`.
 *
 * Multi-outlet support (HS300 / KP200):
 *   - `target.child` set → command targets that single outlet via
 *     `context: { child_ids: [target.child] }`.
 *   - `target.child` unset + the device's sysinfo reports children →
 *     command broadcasts to every child outlet in one call.
 *   - Single-outlet plug → original behaviour, no overhead.
 */
import { self as rawSelf } from "@cldmv/slothlet/runtime";
import type { CommandOptions, DeviceTarget, Failure, OpResult, PlugApi, SelfApi } from "../../lib/types.mts";

const self = rawSelf as unknown as SelfApi;

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

/** Read full sysinfo (children + relay_state) once per command. Used for routing + verify. */
async function readSysInfo(target: DeviceTarget): Promise<{ relay_state?: 0 | 1; children?: SysChild[] } | Failure> {
	const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
	const info = response.system?.get_sysinfo as { relay_state?: 0 | 1; children?: SysChild[] } | undefined;
	if (!info) return self.events.failure(`Device at ${target.host} returned no sysinfo`);
	return info;
}

/** Raw relay write — no event wrapping. */
async function sendRelay(target: DeviceTarget, state: 0 | 1, childIds?: string[]): Promise<unknown | Failure> {
	const command: Record<string, Record<string, unknown>> = { system: { set_relay_state: { state } } };
	if (childIds && childIds.length > 0) command.context = { child_ids: childIds };
	const response = await self.protocol.send(target, command);
	return checkError(response.system?.set_relay_state, "plug relay");
}

/**
 * Decide the set of child IDs (if any) for an on/off call:
 *   - `target.child` set                                 → `[target.child]`
 *   - `target.child` unset, device has children          → all children (broadcast)
 *   - single-outlet device                                → `undefined` (parent relay)
 *   - sysinfo unreadable (broken / non-conforming device) → `undefined`, bare write
 *
 * A failed sysinfo pre-read is deliberately non-fatal: real Kasa plugs always
 * answer get_sysinfo, so the only time it fails is a misbehaving device or a
 * test fake. Falling back to the bare write preserves the original behaviour
 * for single-outlet plugs without forcing every test fake to grow a sysinfo
 * branch.
 */
async function routeChildIds(target: DeviceTarget): Promise<{ ids: string[] | undefined }> {
	if (target.child) return { ids: [target.child] };
	const info = await readSysInfo(target);
	if (self.events.isFailure(info)) return { ids: undefined };
	const kids = info.children;
	if (kids && kids.length > 0) return { ids: kids.map((c) => c.id) };
	return { ids: undefined };
}

/** Verify that every relevant outlet (or the parent's relay) matches `want`. */
async function verifyState(target: DeviceTarget, want: 0 | 1, ids: string[] | undefined): Promise<boolean> {
	const info = await readSysInfo(target);
	if (self.events.isFailure(info)) return false;
	if (ids && ids.length > 0) {
		const kids = info.children ?? [];
		return ids.every((id) => kids.find((c) => c.id === id)?.state === want);
	}
	return info.relay_state === want;
}

/** Read the parent's relay state (single-outlet path). */
async function readState(target: DeviceTarget): Promise<(0 | 1) | Failure> {
	const info = await readSysInfo(target);
	if (self.events.isFailure(info)) return info;
	if (info.relay_state === 0 || info.relay_state === 1) return info.relay_state;
	// Strip without an explicit child: aggregate the children — "on" if any are on.
	const kids = info.children;
	if (kids && kids.length > 0) return kids.some((c) => c.state === 1) ? 1 : 0;
	return self.events.failure(`Device at ${target.host} did not report a relay_state`);
}

/** Power the outlet on. With `target.child`: just that outlet. On a strip with no child: all outlets. */
export function on(target: DeviceTarget, options?: CommandOptions): Promise<OpResult> {
	return self.events.run(
		"plug.on",
		target,
		[],
		async () => {
			const route = await routeChildIds(target);
			return sendRelay(target, 1, route.ids);
		},
		{
			confirm: options?.confirm,
			verify: async () => {
				const ids = target.child ? [target.child] : undefined;
				if (ids) return verifyState(target, 1, ids);
				// Strip broadcast: re-read sysinfo to find the children, then verify all.
				const info = await readSysInfo(target);
				if (self.events.isFailure(info)) return false;
				const kids = info.children;
				if (kids && kids.length > 0) return verifyState(target, 1, kids.map((c) => c.id));
				return info.relay_state === 1;
			}
		}
	);
}

/** Power the outlet off. See {@link on} for child / strip semantics. */
export function off(target: DeviceTarget, options?: CommandOptions): Promise<OpResult> {
	return self.events.run(
		"plug.off",
		target,
		[],
		async () => {
			const route = await routeChildIds(target);
			return sendRelay(target, 0, route.ids);
		},
		{
			confirm: options?.confirm,
			verify: async () => {
				const ids = target.child ? [target.child] : undefined;
				if (ids) return verifyState(target, 0, ids);
				const info = await readSysInfo(target);
				if (self.events.isFailure(info)) return false;
				const kids = info.children;
				if (kids && kids.length > 0) return verifyState(target, 0, kids.map((c) => c.id));
				return info.relay_state === 0;
			}
		}
	);
}

/**
 * Read the current state then flip it. `value` is the new state.
 *
 * For a single outlet (or `target.child` set): the obvious read + write.
 * For a strip with no `target.child`: aggregate — if any outlet is on, turn
 * the whole strip off; otherwise turn it all on. Matches the on/off broadcast
 * semantics so toggle stays internally consistent.
 */
export function toggle(target: DeviceTarget, options?: CommandOptions): Promise<OpResult<0 | 1>> {
	let next: 0 | 1 = 0;
	let writtenIds: string[] | undefined;
	return self.events.run(
		"plug.toggle",
		target,
		[],
		async () => {
			const info = await readSysInfo(target);
			if (self.events.isFailure(info)) return info;
			const kids = info.children;
			if (target.child) {
				// Specific child — flip just that outlet's state.
				const child = kids?.find((c) => c.id === target.child);
				if (!child) return self.events.failure(`child ${target.child} not found on ${target.host}`);
				next = child.state === 1 ? 0 : 1;
				writtenIds = [target.child];
			} else if (kids && kids.length > 0) {
				// Strip broadcast — if any are on, turn the strip off; else turn it on.
				next = kids.some((c) => c.state === 1) ? 0 : 1;
				writtenIds = kids.map((c) => c.id);
			} else {
				// Single-outlet plug — parent's relay_state.
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

/** Relay power state. `set` routes to `on`/`off` (and so inherits the child semantics). */
export const power: PlugApi["power"] = {
	get: (target) => self.events.run("plug.power.get", target, [], () => readState(target)),
	set: (target, isOn, options) => (isOn ? on(target, options) : off(target, options))
};

/**
 * Per-outlet control for multi-outlet strips (HS300, KP200) — explicit
 * `childIds` form. For ergonomic child control, prefer a child-aware ref or
 * `target.child` with the regular `on()`/`off()`/`toggle()` calls.
 * Verifies each child's state in `sysinfo.children`.
 */
export const children: PlugApi["children"] = {
	set: (target, childIds, isOn, options) =>
		self.events.run(
			"plug.children.set",
			target,
			[childIds, isOn],
			() => {
				if (childIds.length === 0) return self.events.failure("children.set requires at least one child id");
				return sendRelay(target, isOn ? 1 : 0, childIds);
			},
			{
				confirm: options?.confirm,
				verify: async () => {
					if (childIds.length === 0) return false;
					return verifyState(target, isOn ? 1 : 0, childIds);
				}
			}
		)
};
