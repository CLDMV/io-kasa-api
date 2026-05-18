/**
 * Kasa API — slothlet-built module surface for TP-Link Kasa IoT devices.
 *
 * Slothlet loads the `.mts` modules under `src/api/` directly (`typescript: true`,
 * esbuild fast mode). Slothlet 3.5.0+ writes each transpiled module to a real
 * file under `.slothlet-cache/`, so cross-module `import { self } from
 * "@cldmv/slothlet/runtime"` resolves normally — no prebuild needed.
 *
 * @example
 * import { createKasaApi } from "./index.mts";
 *
 * const api = await createKasaApi();
 * const devices = await api.discovery.discover();
 * for (const { host } of devices) await api.plug.on({ host });
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import slothlet from "@cldmv/slothlet";
import type { SelfApi } from "./lib/types.mts";

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
}

/** The fully built Kasa API surface, plus slothlet's management handle. */
export type KasaApi = SelfApi & {
  slothlet: {
    shutdown?: () => Promise<void>;
    [key: string]: unknown;
  };
};

/**
 * Build a Kasa API instance via slothlet's runtime TypeScript loader.
 * Each call returns an independent instance with its own context.
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
  return built as unknown as KasaApi;
}

export type {
  DeviceTarget,
  SendOptions,
  KasaCommand,
  KasaResponse,
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
  SelfApi,
  ProtocolApi,
  DiscoveryApi,
  DeviceApi,
  PlugApi,
  SwitchApi,
  DimmerApi,
  MotionApi,
  BulbApi,
  EnergyApi,
  ScheduleApi
} from "./lib/types.mts";
