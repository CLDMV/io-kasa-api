/**
 * Smart-plug relay control, addressed as nested resources:
 *   plug.power.{get,set} · plug.on() · plug.off() · plug.toggle() · plug.children.set()
 *
 * `power.set(bool)` is a thin router to `on`/`off` — the real op (and event)
 * is `plug.on` / `plug.off`. No `throw` in this file; failures return as
 * `self.events.failure(...)` sentinels that `run()` converts to `ok: false`.
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

/** Raw relay write — no event wrapping. */
async function sendRelay(target: DeviceTarget, state: 0 | 1, childIds?: string[]): Promise<unknown | Failure> {
	const command: Record<string, Record<string, unknown>> = { system: { set_relay_state: { state } } };
	if (childIds && childIds.length > 0) command.context = { child_ids: childIds };
	const response = await self.protocol.send(target, command);
	return checkError(response.system?.set_relay_state, "plug relay");
}

/** Raw relay read — no event wrapping. */
async function readState(target: DeviceTarget): Promise<(0 | 1) | Failure> {
	const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
	const sysInfo = response.system?.get_sysinfo as { relay_state?: 0 | 1 } | undefined;
	if (sysInfo?.relay_state === 0 || sysInfo?.relay_state === 1) return sysInfo.relay_state;
	return self.events.failure(`Device at ${target.host} did not report a relay_state`);
}

async function relayIs(target: DeviceTarget, want: 0 | 1): Promise<boolean> {
	const r = await readState(target);
	return !self.events.isFailure(r) && r === want;
}

/** Power the outlet on. */
export function on(target: DeviceTarget, options?: CommandOptions): Promise<OpResult> {
	return self.events.run("plug.on", target, [], () => sendRelay(target, 1), {
		confirm: options?.confirm,
		verify: () => relayIs(target, 1)
	});
}

/** Power the outlet off. */
export function off(target: DeviceTarget, options?: CommandOptions): Promise<OpResult> {
	return self.events.run("plug.off", target, [], () => sendRelay(target, 0), {
		confirm: options?.confirm,
		verify: () => relayIs(target, 0)
	});
}

/** Read the current state then flip it. `value` is the new state. */
export function toggle(target: DeviceTarget, options?: CommandOptions): Promise<OpResult<0 | 1>> {
	let next: 0 | 1 = 0;
	return self.events.run(
		"plug.toggle",
		target,
		[],
		async () => {
			const current = await readState(target);
			if (self.events.isFailure(current)) return current;
			next = current === 1 ? 0 : 1;
			const written = await sendRelay(target, next);
			if (self.events.isFailure(written)) return written;
			return next;
		},
		{ confirm: options?.confirm, verify: () => relayIs(target, next) }
	);
}

/** Relay power state. `set` routes to `on`/`off`. */
export const power: PlugApi["power"] = {
	get: (target) => self.events.run("plug.power.get", target, [], () => readState(target)),
	set: (target, isOn, options) => (isOn ? on(target, options) : off(target, options))
};

/**
 * Per-outlet control for multi-outlet strips (HS300, KP200).
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
					const response = await self.protocol.send(target, { system: { get_sysinfo: {} } });
					const kids = (response.system?.get_sysinfo as { children?: Array<{ id: string; state: 0 | 1 }> } | undefined)?.children;
					if (!kids) return false;
					const wanted = isOn ? 1 : 0;
					return childIds.every((id) => kids.find((c) => c.id === id)?.state === wanted);
				}
			}
		)
};
