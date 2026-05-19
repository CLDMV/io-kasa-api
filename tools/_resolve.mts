/**
 * Shared CLI-tool helper: resolve a device argument to a target.
 *
 * Wraps `api.devices.resolve` so every tool accepts a MAC, an alias (name),
 * or an IP. Prints a one-line banner; exits the process on a miss.
 */
import type { DeviceTarget, KasaApi } from "../src/index.mts";

/**
 * Resolve a MAC / alias / IP via the device cache, print a banner, and
 * `process.exit(1)` if it can't be found.
 *
 * @param api - A built Kasa API (its `sweepCidr` controls what gets scanned).
 * @param ref - MAC, alias, or IP the user passed on the command line.
 */
export async function resolveOrExit(api: KasaApi, ref: string): Promise<DeviceTarget> {
	process.stdout.write(`Resolving "${ref}" ... `);
	const target = await api.devices.resolve(ref);
	if (target === null) {
		console.log("not found");
		// The sweep already ran (resolve populated the cache) — show what it saw,
		// so a typo or wrong name is obvious.
		const devices = await api.devices.list();
		if (devices.length === 0) {
			console.error("No Kasa devices found — check the CIDR (KASA_SWEEP env) and connectivity.");
		} else {
			console.error(`"${ref}" isn't among the ${devices.length} device(s) found:`);
			for (const d of [...devices].sort((a, b) =>
				String(a.sysInfo.alias ?? "").localeCompare(String(b.sysInfo.alias ?? ""))
			)) {
				console.error(`  ${d.sysInfo.alias ?? "(unnamed)"}  —  ${d.host}  ${d.sysInfo.mac ?? ""}`);
			}
		}
		process.exit(1);
	}
	const info = await api.device.info.get(target);
	const label = info.ok && info.value ? `"${info.value.alias}" (${info.value.model})` : "(info unavailable)";
	console.log(`→ ${label} at ${target.host}`);
	return target;
}
