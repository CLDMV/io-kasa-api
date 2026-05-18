/**
 * Kasa API — slothlet-built module surface for TP-Link Kasa IoT devices.
 *
 * Slothlet loads the `.mts` modules under `src/api/` directly (`typescript: true`,
 * esbuild fast mode). Slothlet 3.5.0+ writes each transpiled module to a real
 * file under `.slothlet-cache/`, so cross-module `import { self } from
 * "@cldmv/slothlet/runtime"` resolves normally — no prebuild needed.
 *
 * The `bulk` and `signal` layers are not slothlet modules — they are dynamic
 * meta-layers built by walking the loaded API and attached here.
 *
 * @example
 * import { createKasaApi } from "./index.mts";
 *
 * const api = await createKasaApi();
 * api.events.on("error", (e) => console.warn(`${e.op} @ ${e.host}: ${e.error}`));
 * const results = await api.bulk.plug.on([{ host: "10.8.1.5" }, { host: "10.8.1.12" }]);
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import slothlet from "@cldmv/slothlet";
import { buildBulk } from "./lib/bulk.mts";
import { buildSignal } from "./lib/signal.mts";
import type { BulkApi, SelfApi, SignalApi } from "./lib/types.mts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Options forwarded to slothlet. */
export interface CreateKasaApiOptions {
  /** API module directory. Defaults to `<this dir>/api`. */
  dir?: string;
  /** `"eager"` (default) loads everything up-front; `"lazy"` defers per-module load. */
  mode?: "eager" | "lazy";
  /** Enable slothlet's debug logging. */
  debug?: boolean;
  /** Extra context propagated through `@cldmv/slothlet/runtime`. */
  context?: Record<string, unknown>;
  /** Default in-flight probe count for `api.bulk.*` calls. Defaults to 32. */
  bulkConcurrency?: number;
}

/** The fully built Kasa API surface, plus the dynamic layers and slothlet's handle. */
export type KasaApi = SelfApi & {
  /** Dynamic bulk layer — `api.bulk.plug.on(targets)` etc. */
  bulk: BulkApi;
  /** Network-health reporting. */
  signal: SignalApi;
  slothlet: {
    shutdown?: () => Promise<void>;
    [key: string]: unknown;
  };
};

/**
 * Build a Kasa API instance via slothlet's runtime TypeScript loader.
 * Each call returns an independent instance with its own event bus and context.
 */
export async function createKasaApi(options: CreateKasaApiOptions = {}): Promise<KasaApi> {
  const dir = options.dir ?? resolve(HERE, "api");
  const built = await slothlet({
    dir,
    mode: options.mode ?? "eager",
    debug: options.debug ?? false,
    context: options.context ?? {},
    // `typescript` is honoured by the loader but absent from the public option
    // types; cast keeps the call type-safe for the documented fields.
    ...({ typescript: true } as Record<string, unknown>)
  } as Parameters<typeof slothlet>[0]);

  const api = built as unknown as KasaApi;
  // Attach the dynamic meta-layers (built by walking the loaded API).
  api.bulk = buildBulk(api as unknown as Record<string, Record<string, unknown>>, options.bulkConcurrency);
  api.signal = buildSignal(api as unknown as Parameters<typeof buildSignal>[0]);
  return api;
}

export type {
  DeviceTarget,
  SendOptions,
  KasaCommand,
  KasaResponse,
  OpResult,
  OpEvent,
  OpEventListener,
  SysInfo,
  LightState,
  EnergyRealtime,
  DiscoveredDevice,
  DiscoverOptions,
  SweepOptions,
  ResolvedBroadcast,
  DimmerActionMode,
  DimmerParameters,
  PirConfig,
  AmbientLightConfig,
  WatchOptions,
  MonitorEvent,
  DeviceMonitor,
  SignalEntry,
  SignalReportOptions,
  Bulkified,
  SelfApi,
  ProtocolApi,
  DiscoveryApi,
  EventsApi,
  DeviceApi,
  PlugApi,
  SwitchApi,
  DimmerApi,
  MotionApi,
  BulbApi,
  EnergyApi,
  ScheduleApi,
  MonitorApi,
  BulkApi,
  SignalApi
} from "./lib/types.mts";
