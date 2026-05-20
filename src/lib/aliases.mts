/**
 * Alias-management helper — `api.aliases.apply` and `api.aliases.watch`.
 *
 * Takes a desired-state {@link AliasMap} (loaded from a JSON file, an object,
 * or a function) and ensures the matching devices on the network carry the
 * requested aliases. Each map key is either an IPv4 string or a MAC string
 * (any separator, any case); each value is the alias the device should have.
 *
 *   - `apply(source, opts)`  — one-shot rename pass; returns an `ApplyReport`.
 *   - `watch(source, opts)`  — interval monitor; re-applies drift each tick.
 *
 * Both forms re-evaluate file / function sources on every call (or every
 * tick, for `watch`) so you can edit the JSON or have your function return
 * updated data and the watcher picks it up without a restart.
 *
 * Imported by `index.mts`; not loaded by slothlet.
 */
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { isIpv4 } from "./devices.mts";
import type {
	AliasMap,
	AliasOutcome,
	AliasSource,
	AliasWatcher,
	AliasesApi,
	ApplyOptions,
	ApplyReport,
	DeviceTarget,
	DevicesApi,
	DiscoveredDevice,
	EventsApi,
	OpResult,
	SysInfo,
	WatchAliasesOptions,
	WithRefSupport,
	DeviceApi
} from "./types.mts";

const DEFAULT_INTERVAL_MS = 30_000;

type AnyApi = {
	devices: DevicesApi;
	events: EventsApi;
	// Built after attachRefResolution, so this leaf accepts DeviceRef at runtime.
	device: WithRefSupport<DeviceApi>;
};

// -----------------------------------------------------------------------------
// Source loading — string (file path) | AliasMap | function returning either.
// -----------------------------------------------------------------------------

/** Hex-only lowercased — compares MACs regardless of separators or case. */
function normMac(s: string | undefined): string {
	return (s ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

function isMacLike(key: string): boolean {
	return normMac(key).length === 12;
}

/** Load + parse the source. Returns `null` (and surfaces an error) on failure. */
async function loadSource(source: AliasSource, onError: (err: Error) => void): Promise<AliasMap | null> {
	try {
		if (typeof source === "string") {
			const raw = await readFile(source, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				onError(new Error(`alias source ${JSON.stringify(source)} is not a JSON object`));
				return null;
			}
			return parsed as AliasMap;
		}
		if (typeof source === "function") {
			const result = await source();
			return result;
		}
		return source;
	} catch (err) {
		onError(err instanceof Error ? err : new Error(String(err)));
		return null;
	}
}

// -----------------------------------------------------------------------------
// Key parsing — `host[/childIndexOrId]` syntax.
//
// Map keys come in two shapes:
//   "10.8.1.50"       → device-level alias (the strip / switch / bulb itself)
//   "10.8.1.50/0"     → outlet 0 of a multi-outlet device (HS300 / KP200)
//   "aa:bb:.../1"     → outlet 1, addressed by parent MAC
//   "<...>/<long-hex>" → outlet identified by its full child ID
//
// IPv4 addresses contain dots but never slashes; MACs contain hex + : / -
// but no slashes. So `/` is an unambiguous separator.
// -----------------------------------------------------------------------------

interface ParsedKey {
	host: string;
	/** When set, the right-hand side of the `/` — a digit index or a hex child ID. */
	child?: string;
}

function parseKey(key: string): ParsedKey {
	const slash = key.indexOf("/");
	if (slash < 0) return { host: key };
	return { host: key.slice(0, slash), child: key.slice(slash + 1) };
}

// -----------------------------------------------------------------------------
// Device + child matching.
// -----------------------------------------------------------------------------

function matchDevice(devices: ReadonlyArray<DiscoveredDevice>, host: string): DiscoveredDevice | undefined {
	if (isIpv4(host)) return devices.find((d) => d.host === host);
	if (isMacLike(host)) {
		const want = normMac(host);
		return devices.find((d) => normMac(String(d.sysInfo.mac ?? d.sysInfo.mic_mac ?? "")) === want);
	}
	return undefined;
}

type SysInfoChild = { id: string; alias: string; state: 0 | 1 };

/**
 * Find a child outlet on `device` by index ("0", "1") or by its full child ID.
 * Returns `undefined` if the device has no children or no match.
 */
function findChild(device: DiscoveredDevice, ref: string): SysInfoChild | undefined {
	const kids = (device.sysInfo.children as SysInfoChild[] | undefined) ?? [];
	if (kids.length === 0) return undefined;
	// Numeric index first — most common in JSON maps.
	if (/^\d+$/.test(ref)) {
		const idx = Number(ref);
		return kids[idx];
	}
	// Otherwise match by full child ID (case-insensitive — IDs are hex).
	const want = ref.toLowerCase();
	return kids.find((c) => c.id.toLowerCase() === want);
}

// -----------------------------------------------------------------------------
// One-shot apply.
// -----------------------------------------------------------------------------

interface RenameCallbacks {
	/** Fires once per successful rename — used by the watcher to emit `"renamed"`. */
	onRenamed?: (outcome: AliasOutcome) => void;
}

async function applyMap(
	api: AnyApi,
	map: AliasMap,
	options: ApplyOptions,
	callbacks: RenameCallbacks = {}
): Promise<ApplyReport> {
	const confirm = options.confirm ?? true;
	const force = options.force ?? false;

	// Single sweep / cache read covers every key.
	const devices = force ? await api.devices.refresh() : await api.devices.list();

	const outcomes: AliasOutcome[] = [];
	for (const [key, desired] of Object.entries(map)) {
		if (typeof desired !== "string") {
			outcomes.push({
				key,
				desired: String(desired),
				action: "failed",
				error: `desired alias for ${JSON.stringify(key)} is not a string`
			});
			continue;
		}
		const parsed = parseKey(key);
		const device = matchDevice(devices, parsed.host);
		if (!device) {
			outcomes.push({ key, desired, action: "missing" });
			continue;
		}

		// Child-outlet key: resolve the index / ID against sysInfo.children.
		let child: SysInfoChild | undefined;
		if (parsed.child !== undefined) {
			child = findChild(device, parsed.child);
			if (!child) {
				outcomes.push({
					key,
					desired,
					host: device.host,
					action: "missing",
					error: `no child outlet matches "${parsed.child}" on ${device.host}`
				});
				continue;
			}
		}

		const current = child ? String(child.alias ?? "") : String(device.sysInfo.alias ?? "");
		if (current === desired) {
			outcomes.push({
				key,
				desired,
				current,
				host: device.host,
				action: "unchanged",
				...(child ? { child: child.id } : {})
			});
			continue;
		}

		// Preserve port from the discovered device — real Kasa is always 9999, but
		// keeping it explicit lets tests (and odd setups) use non-standard ports.
		const target: DeviceTarget = { host: device.host, port: device.port };
		// Build options inline — only include set keys (exactOptionalPropertyTypes).
		const setOptions: { confirm?: boolean; child?: string } = {};
		if (confirm) setOptions.confirm = true;
		if (child) setOptions.child = child.id;
		const result: OpResult = await api.device.alias.set(target, desired, setOptions);
		if (!result.ok) {
			outcomes.push({
				key,
				desired,
				current,
				host: device.host,
				action: "failed",
				error: result.error ?? "unknown",
				...(child ? { child: child.id } : {})
			});
			continue;
		}
		const outcome: AliasOutcome = {
			key,
			desired,
			current,
			host: device.host,
			action: "renamed",
			...(child ? { child: child.id } : {})
		};
		outcomes.push(outcome);
		callbacks.onRenamed?.(outcome);

		// Update the in-memory cached sysInfo so a watcher's next tick sees the
		// new alias instantly (otherwise we'd rename it again from the stale cache).
		if (child) child.alias = desired;
		else (device.sysInfo as SysInfo).alias = desired;
	}

	const counts = {
		renamed: outcomes.filter((o) => o.action === "renamed").length,
		unchanged: outcomes.filter((o) => o.action === "unchanged").length,
		missing: outcomes.filter((o) => o.action === "missing").length,
		failed: outcomes.filter((o) => o.action === "failed").length
	};
	return { at: Date.now(), outcomes, counts };
}

// -----------------------------------------------------------------------------
// Watcher.
// -----------------------------------------------------------------------------

class KasaAliasWatcher extends EventEmitter implements AliasWatcher {
	readonly #api: AnyApi;
	readonly #source: AliasSource;
	readonly #options: ApplyOptions;
	readonly #intervalMs: number;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#inflight: Promise<ApplyReport> | null = null;

	constructor(api: AnyApi, source: AliasSource, options: WatchAliasesOptions) {
		super();
		this.#api = api;
		this.#source = source;
		this.#options = { confirm: options.confirm ?? true, force: options.force ?? false };
		this.#intervalMs = Math.max(1000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
	}

	start(runImmediately: boolean): void {
		if (runImmediately) void this.#runTick();
		else this.#schedule();
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.emit("stop");
	}

	/** Force an immediate apply outside the interval. */
	tick(): Promise<ApplyReport> {
		return this.#runTick();
	}

	#schedule(): void {
		if (this.#stopped) return;
		this.#timer = setTimeout(() => void this.#runTick(), this.#intervalMs);
	}

	async #runTick(): Promise<ApplyReport> {
		// Coalesce overlapping ticks (a slow apply shouldn't start a second one).
		if (this.#inflight) return this.#inflight;
		this.#inflight = (async () => {
			try {
				const map = await loadSource(this.#source, (err) => this.emit("error", err));
				if (map === null) {
					return { at: Date.now(), outcomes: [], counts: { renamed: 0, unchanged: 0, missing: 0, failed: 0 } };
				}
				const report = await applyMap(this.#api, map, this.#options, {
					onRenamed: (outcome) => this.emit("renamed", outcome)
				});
				const missing = report.outcomes.filter((o) => o.action === "missing").map((o) => o.key);
				if (missing.length > 0) this.emit("missing", missing);
				this.emit("tick", report);
				return report;
			} catch (err) {
				this.emit("error", err instanceof Error ? err : new Error(String(err)));
				return { at: Date.now(), outcomes: [], counts: { renamed: 0, unchanged: 0, missing: 0, failed: 0 } };
			} finally {
				this.#inflight = null;
				if (!this.#stopped) this.#schedule();
			}
		})();
		return this.#inflight;
	}
}

// -----------------------------------------------------------------------------
// Public surface.
// -----------------------------------------------------------------------------

/** Build the `api.aliases` surface from the live API object. */
export function buildAliases(api: AnyApi): AliasesApi {
	return {
		async apply(source: AliasSource, options: ApplyOptions = {}): Promise<ApplyReport> {
			const errors: Error[] = [];
			const map = await loadSource(source, (err) => errors.push(err));
			if (map === null) {
				const message = errors[0]?.message ?? "alias source load failed";
				return {
					at: Date.now(),
					outcomes: [{ key: "<source>", desired: "", action: "failed", error: message }],
					counts: { renamed: 0, unchanged: 0, missing: 0, failed: 1 }
				};
			}
			return applyMap(api, map, options);
		},
		watch(source: AliasSource, options: WatchAliasesOptions = {}): AliasWatcher {
			const watcher = new KasaAliasWatcher(api, source, options);
			watcher.start(options.runImmediately ?? true);
			return watcher;
		}
	};
}
