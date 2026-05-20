/**
 * Kasa API — slothlet-built module surface for TP-Link Kasa IoT devices.
 *
 * Slothlet loads the `.mts` modules under `src/api/` directly (`typescript: true`,
 * esbuild fast mode). Slothlet 3.5.0+ writes each transpiled module to a real
 * file under `.slothlet-cache/`, so cross-module `import { self } from
 * "@cldmv/slothlet/runtime"` resolves normally — no prebuild needed.
 *
 * The `bulk`, `signal`, and `devices` layers are not slothlet modules — they
 * are dynamic meta-layers built by walking the loaded API and attached here.
 * `attachRefResolution` then wraps every single-device module so it accepts
 * any {@link DeviceRef} (IP / MAC / alias string, or `DeviceTarget`); the bulk
 * wrappers use the same shared adapter on their per-slot resolution.
 *
 * @example
 * import { createKasaApi } from "./index.mts";
 *
 * const api = await createKasaApi();
 * api.events.on("error", (e) => console.warn(`${e.op} @ ${e.host}: ${e.error}`));
 *
 * // Single-device — any DeviceRef:
 * await api.switch.on("10.8.1.5");
 * await api.switch.on("Bedroom Lamp");
 * await api.switch.on({ host: "10.8.1.5", timeoutMs: 2000 });
 *
 * // Bulk — mixed array of refs:
 * const results = await api.bulk.plug.on([
 *   "10.8.1.5",
 *   "aa:bb:cc:dd:ee:ff",
 *   "Pantry Light",
 *   { host: "10.8.1.12", port: 9999 }
 * ]);
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import slothlet from "@cldmv/slothlet";
import { buildBulk } from "./lib/bulk.mts";
import { buildSignal } from "./lib/signal.mts";
import { buildDevices } from "./lib/devices.mts";
import { attachRefResolution, wrapMonitor } from "./lib/refs.mts";
import { buildLink } from "./lib/link.mts";
import type {
  BulkApi,
  DevicesApi,
  LinkApi,
  SelfApi,
  SignalApi,
  WithRefSupport,
  DeviceApi,
  PlugApi,
  SwitchApi,
  DimmerApi,
  MotionApi,
  BulbApi,
  EnergyApi,
  ScheduleApi,
  MonitorApi
} from "./lib/types.mts";

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
  /** CIDR the `api.devices` resolver sweeps. Defaults to `KASA_SWEEP` env or `10.8.0.0/23`. */
  sweepCidr?: string;
  /**
   * Global default for verified writes. When `true`, every mutating command
   * reads the value back and resolves `ok: false` if it doesn't match. Can be
   * overridden per-target (`{ host, confirm: false }`) and per-call
   * (`api.switch.on(t, { confirm: true })`). Defaults to `false`.
   */
  confirm?: boolean;
  /**
   * Global default for bypassing the resolver sweep cache when a command is
   * called with a MAC/alias ref. When `true`, every MAC/alias resolution
   * re-sweeps the network first. Overridable per-target (`{ host, force: true }`)
   * and per-call (`api.switch.on("Lamp", { force: true })`). No-op for
   * `DeviceTarget` and IPv4-string refs. Defaults to `false`.
   */
  force?: boolean;
}

/**
 * The fully built Kasa API surface, plus the dynamic layers and slothlet's handle.
 *
 * Every single-device module on this type is wrapped with
 * {@link WithRefSupport} — each leaf accepts any {@link DeviceRef} (IP / MAC /
 * alias string, or `DeviceTarget`). The slothlet-internal `SelfApi` is the
 * narrow `DeviceTarget`-only view; `index.mts` mutates the runtime modules in
 * place via `attachRefResolution` so the live object matches this wider type.
 */
export type KasaApi = Omit<SelfApi, "device" | "plug" | "switch" | "dimmer" | "motion" | "bulb" | "energy" | "schedule" | "monitor"> & {
  device: WithRefSupport<DeviceApi>;
  plug: WithRefSupport<PlugApi>;
  switch: WithRefSupport<SwitchApi>;
  dimmer: WithRefSupport<DimmerApi>;
  motion: WithRefSupport<MotionApi>;
  bulb: WithRefSupport<BulbApi>;
  energy: WithRefSupport<EnergyApi>;
  schedule: WithRefSupport<ScheduleApi>;
  monitor: WithRefSupport<MonitorApi>;
  /** Dynamic bulk layer — `api.bulk.plug.on(refs)` etc., refs may be any mix of DeviceRefs. */
  bulk: BulkApi;
  /** Network-health reporting. */
  signal: SignalApi;
  /** Device discovery cache + MAC/name/IP resolver. */
  devices: DevicesApi;
  /** Device-linking helper — gang N devices so one transition propagates to all. */
  link: LinkApi["link"];
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

  // Wire bus-level defaults — global confirm + force toggles.
  api.events.configure({
    ...(typeof options.confirm === "boolean" ? { confirm: options.confirm } : {}),
    ...(typeof options.force === "boolean" ? { force: options.force } : {})
  });
  // Live defaults snapshot — captured by ref in the wrappers below, so a later
  // api.events.configure(...) call is observed without rewiring.
  const defaults = api.events.getDefaults();

  // Attach the dynamic meta-layers. Order matters:
  //   1. devices — bulk and refs both need the resolver.
  //   2. bulk    — walks the *unwrapped* single-device leaves; once wrapped
  //                they'd double-resolve and the per-slot force pluck wouldn't
  //                see options that the wrapper already consumed.
  //   3. attachRefResolution — mutates the single-device modules in place so
  //                api.switch.on("Lamp") works for callers.
  //   4. signal  — uses bulk + discovery; built last so report() sees bulk.
  const devices = buildDevices(
    api as unknown as Parameters<typeof buildDevices>[0],
    options.sweepCidr ?? process.env.KASA_SWEEP
  );
  api.devices = devices;
  api.bulk = buildBulk(
    api as unknown as Record<string, Record<string, unknown>>,
    { devices, events: api.events, defaults },
    options.bulkConcurrency
  );
  attachRefResolution(api as unknown as Record<string, unknown>, { devices, events: api.events, defaults });
  if (api.monitor) wrapMonitor(api.monitor as unknown as Parameters<typeof wrapMonitor>[0], { devices, events: api.events, defaults });
  api.signal = buildSignal(api as unknown as Parameters<typeof buildSignal>[0]);
  // link builds on the ref-supporting api.monitor + api.bulk, so it must come
  // after attachRefResolution / wrapMonitor / buildBulk.
  api.link = buildLink(api as unknown as Parameters<typeof buildLink>[0]).link;

  return api;
}

export type {
  DeviceTarget,
  DeviceRef,
  CommandOptions,
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
  WatchMotionOptions,
  MonitorEvent,
  MonitorEventCause,
  PirMotionEvent,
  DeviceMonitor,
  LinkApi,
  LinkOptions,
  LinkPropagation,
  LinkedGroup,
  SignalEntry,
  SignalReportOptions,
  Bulkified,
  WithRefSupport,
  ResourceGet,
  ScalarResource,
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
  SignalApi,
  DevicesApi,
  DevicesScanOptions
} from "./lib/types.mts";
