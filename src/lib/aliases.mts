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
// Key matching — find the DiscoveredDevice for an AliasMap key (IP or MAC).
// -----------------------------------------------------------------------------

function matchDevice(devices: ReadonlyArray<DiscoveredDevice>, key: string): DiscoveredDevice | undefined {
	if (isIpv4(key)) return devices.find((d) => d.host === key);
	if (isMacLike(key)) {
		const want = normMac(key);
		return devices.find((d) => normMac(String(d.sysInfo.mac ?? d.sysInfo.mic_mac ?? "")) === want);
	}
	return undefined;
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
		const device = matchDevice(devices, key);
		if (!device) {
			outcomes.push({ key, desired, action: "missing" });
			continue;
		}
		const current = String(device.sysInfo.alias ?? "");
		if (current === desired) {
			outcomes.push({ key, desired, current, host: device.host, action: "unchanged" });
			continue;
		}
		// Preserve port from the discovered device — real Kasa is always 9999, but
		// keeping it explicit lets tests (and odd setups) use non-standard ports.
		const target: DeviceTarget = { host: device.host, port: device.port };
		const setOptions = confirm ? { confirm: true } : undefined;
		const result: OpResult = setOptions
			? await api.device.alias.set(target, desired, setOptions)
			: await api.device.alias.set(target, desired);
		if (!result.ok) {
			outcomes.push({
				key,
				desired,
				current,
				host: device.host,
				action: "failed",
				error: result.error ?? "unknown"
			});
			continue;
		}
		const outcome: AliasOutcome = {
			key,
			desired,
			current,
			host: device.host,
			action: "renamed"
		};
		outcomes.push(outcome);
		callbacks.onRenamed?.(outcome);

		// Update the in-memory cached sysInfo so a watcher's next tick sees the
		// new alias instantly (otherwise we'd rename it again from the stale cache).
		(device.sysInfo as SysInfo).alias = desired;
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
