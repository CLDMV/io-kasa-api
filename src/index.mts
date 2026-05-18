/**
 * Kasa API — slothlet-built module surface for TP-Link Kasa IoT devices.
 *
 * `createKasaApi()` transpiles the `.mts` modules under `src/api/` to `.mjs`
 * at runtime via esbuild, then hands the output directory to slothlet.
 *
 * Why the prebuild: slothlet 3.4.1 routes `.ts`/`.mts` through `esbuild.transform`
 * into a `data:` URL. Node refuses to use a data URL as the base for resolving
 * bare specifiers, so `import { self } from "@cldmv/slothlet/runtime"` (the
 * documented way to do cross-module calls) fails with "Invalid relative URL or
 * base scheme is not hierarchical." Building to real files on disk avoids that.
 *
 * @example
 * import { createKasaApi } from "./index.mts";
 *
 * const api = await createKasaApi();
 * const devices = await api.discovery.discover();
 * for (const { host } of devices) await api.plug.on({ host });
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative, extname, basename } from "node:path";
import { mkdir, readdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import slothlet from "@cldmv/slothlet";
import { transform } from "esbuild";
import type { SelfApi } from "./lib/types.mts";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CreateKasaApiOptions {
  /** Source directory holding `.mts` modules. Defaults to `<this dir>/api`. */
  srcDir?: string;
  /** Where to write the transpiled `.mjs` modules. Defaults to a project-local `.kasa-build` dir. */
  buildDir?: string;
  /** `"eager"` (default) loads everything up-front; `"lazy"` defers per-module load. */
  mode?: "eager" | "lazy";
  /** Enable slothlet's debug logging. */
  debug?: boolean;
  /** Extra context propagated through `@cldmv/slothlet/runtime`. */
  context?: Record<string, unknown>;
}

export type KasaApi = SelfApi & {
  slothlet: {
    shutdown?: () => Promise<void>;
    [key: string]: unknown;
  };
};

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function buildDir(srcDir: string, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for await (const file of walk(srcDir)) {
    if (extname(file) !== ".mts") continue;
    const rel = relative(srcDir, file);
    const outRel = rel.slice(0, -".mts".length) + ".mjs";
    const outFile = join(outDir, outRel);
    const source = await readFile(file, "utf8");
    const result = await transform(source, {
      loader: "ts",
      format: "esm",
      target: "es2022",
      sourcefile: file
    });
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, result.code, "utf8");
  }
}

async function hashSources(dirs: string[]): Promise<string> {
  const hasher = createHash("sha256");
  const items: Array<{ root: string; path: string; mtimeMs: number; size: number }> = [];
  for (const dir of dirs) {
    for await (const file of walk(dir)) {
      if (extname(file) !== ".mts") continue;
      const s = await stat(file);
      items.push({ root: dir, path: relative(dir, file), mtimeMs: s.mtimeMs, size: s.size });
    }
  }
  items.sort((a, b) => (a.root + "/" + a.path).localeCompare(b.root + "/" + b.path));
  hasher.update(JSON.stringify(items.map(({ path, mtimeMs, size }) => ({ path, mtimeMs, size }))));
  return hasher.digest("hex").slice(0, 16);
}

export async function createKasaApi(options: CreateKasaApiOptions = {}): Promise<KasaApi> {
  const apiSrc = options.srcDir ?? resolve(HERE, "api");
  const libSrc = resolve(HERE, "lib");

  const projectRoot = resolve(HERE, "..");
  const defaultBuildRoot = process.env.KASA_API_BUILD_DIR
    ? resolve(process.env.KASA_API_BUILD_DIR)
    : join(projectRoot, ".kasa-build");

  const hash = await hashSources([apiSrc, libSrc]);
  const buildRoot = options.buildDir ?? join(defaultBuildRoot, hash);
  const apiOut = join(buildRoot, "api");
  const libOut = join(buildRoot, "lib");

  let needsBuild = true;
  try {
    const probe = await stat(apiOut);
    if (probe.isDirectory()) needsBuild = false;
  } catch {
    // missing — fall through to build
  }

  if (needsBuild) {
    try {
      const entries = await readdir(defaultBuildRoot);
      await Promise.all(
        entries
          .filter((name) => name !== basename(buildRoot))
          .map((name) => rm(join(defaultBuildRoot, name), { recursive: true, force: true }))
      );
    } catch {
      // root doesn't exist yet — fine
    }
    await Promise.all([buildDir(apiSrc, apiOut), buildDir(libSrc, libOut)]);
  }

  const built = await slothlet({
    dir: apiOut,
    mode: options.mode ?? "eager",
    debug: options.debug ?? false,
    context: options.context ?? {}
  });
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
  SelfApi,
  ProtocolApi,
  DiscoveryApi,
  DeviceApi,
  PlugApi,
  BulbApi,
  EnergyApi,
  ScheduleApi
} from "./lib/types.mts";
