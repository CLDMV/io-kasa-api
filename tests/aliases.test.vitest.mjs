/**
 * api.aliases.apply / api.aliases.watch tests.
 *
 * Covers:
 *   - source forms (object, function, JSON file path)
 *   - key forms (IP, MAC w/ separators, MAC w/o separators, MAC mixed case)
 *   - outcomes (renamed, unchanged, missing, failed)
 *   - watch: drift detection across ticks, hot-reload of file/function source,
 *     stop() halts the interval and emits "stop".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKasaApi } from "../src/index.mts";
import { startFakeTcp } from "./_helpers.mjs";

/** @typedef {Awaited<ReturnType<typeof createKasaApi>>} KasaApi */

/** Build a fake plug that keeps its own alias + MAC and answers system.* commands. */
async function startFakeNamedPlug(initialAlias, mac) {
  let alias = initialAlias;
  const server = await startFakeTcp((cmd) => {
    if (cmd.system?.set_dev_alias) {
      alias = cmd.system.set_dev_alias.alias;
      return { system: { set_dev_alias: { err_code: 0 } } };
    }
    if (cmd.system?.get_sysinfo) {
      return {
        system: {
          get_sysinfo: {
            alias,
            mac,
            model: "HS100(US)",
            relay_state: 0
          }
        }
      };
    }
    return { err: 1 };
  });
  return {
    ...server,
    get alias() {
      return alias;
    }
  };
}

/** Wait for `event` on an EventEmitter (one-shot). */
function nextEvent(emitter, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    emitter.once(event, handler);
  });
}

describe("api.aliases.apply — one-shot rename", () => {
  /** @type {KasaApi} */
  let api;
  beforeAll(async () => {
    api = await createKasaApi();
  });
  afterAll(async () => {
    try {
      await api?.slothlet?.shutdown?.();
    } catch {}
  });

  it("renames a drifted alias matched by IP", async () => {
    const plug = await startFakeNamedPlug("Old Name", "AA:BB:CC:DD:EE:01");
    // Inject the device into the resolver cache so the apply finds it via list().
    api.discovery.sweep = async () => [
      { host: "127.0.0.1", port: plug.port, sysInfo: { alias: plug.alias, mac: "AA:BB:CC:DD:EE:01", model: "HS100(US)" } }
    ];
    await api.devices.refresh();
    try {
      const report = await api.aliases.apply({ "127.0.0.1": "New Name" }, { confirm: false });
      expect(report.counts.renamed).toBe(1);
      expect(report.counts.missing).toBe(0);
      expect(report.outcomes[0].current).toBe("Old Name");
      expect(report.outcomes[0].desired).toBe("New Name");
      expect(plug.alias).toBe("New Name");
    } finally {
      await plug.close();
    }
  });

  it("renames by MAC — any separator + case-insensitive", async () => {
    const plug = await startFakeNamedPlug("Bedroom Original", "11:22:33:AA:BB:CC");
    api.discovery.sweep = async () => [
      { host: "127.0.0.1", port: plug.port, sysInfo: { alias: plug.alias, mac: "11:22:33:AA:BB:CC", model: "HS100(US)" } }
    ];
    await api.devices.refresh();
    try {
      const report = await api.aliases.apply(
        {
          "11-22-33-aa-bb-cc": "Bedroom Lamp" // dashes + lowercase
        },
        { confirm: false }
      );
      expect(report.counts.renamed).toBe(1);
      expect(plug.alias).toBe("Bedroom Lamp");
    } finally {
      await plug.close();
    }
  });

  it("'unchanged' when current alias already matches", async () => {
    const plug = await startFakeNamedPlug("Already Correct", "AA:BB:CC:DD:EE:02");
    api.discovery.sweep = async () => [
      { host: "127.0.0.1", port: plug.port, sysInfo: { alias: "Already Correct", mac: "AA:BB:CC:DD:EE:02", model: "HS100(US)" } }
    ];
    await api.devices.refresh();
    try {
      const report = await api.aliases.apply({ "127.0.0.1": "Already Correct" });
      expect(report.counts.renamed).toBe(0);
      expect(report.counts.unchanged).toBe(1);
      expect(plug.alias).toBe("Already Correct");
    } finally {
      await plug.close();
    }
  });

  it("'missing' when a key has no matching device", async () => {
    api.discovery.sweep = async () => [];
    await api.devices.refresh();
    const report = await api.aliases.apply({
      "10.99.99.99": "Phantom",
      "ff:ff:ff:ff:ff:ff": "Also phantom"
    });
    expect(report.counts.missing).toBe(2);
    expect(report.counts.renamed).toBe(0);
    expect(report.outcomes.every((o) => o.action === "missing")).toBe(true);
  });

  it("accepts a function source (sync return)", async () => {
    const plug = await startFakeNamedPlug("Func Source", "AA:BB:CC:DD:EE:03");
    api.discovery.sweep = async () => [
      { host: "127.0.0.1", port: plug.port, sysInfo: { alias: plug.alias, mac: "AA:BB:CC:DD:EE:03", model: "HS100(US)" } }
    ];
    await api.devices.refresh();
    try {
      const report = await api.aliases.apply(() => ({ "127.0.0.1": "From Function" }), { confirm: false });
      expect(report.counts.renamed).toBe(1);
      expect(plug.alias).toBe("From Function");
    } finally {
      await plug.close();
    }
  });

  it("accepts a JSON file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kasa-aliases-"));
    const path = join(dir, "aliases.json");
    const plug = await startFakeNamedPlug("File Source Old", "AA:BB:CC:DD:EE:04");
    api.discovery.sweep = async () => [
      { host: "127.0.0.1", port: plug.port, sysInfo: { alias: plug.alias, mac: "AA:BB:CC:DD:EE:04", model: "HS100(US)" } }
    ];
    await api.devices.refresh();
    await writeFile(path, JSON.stringify({ "127.0.0.1": "File Source New" }));
    try {
      const report = await api.aliases.apply(path, { confirm: false });
      expect(report.counts.renamed).toBe(1);
      expect(plug.alias).toBe("File Source New");
    } finally {
      await plug.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("malformed JSON file resolves to a failed outcome (no throw)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kasa-aliases-"));
    const path = join(dir, "bad.json");
    await writeFile(path, "{this isn't json}");
    try {
      const report = await api.aliases.apply(path);
      expect(report.counts.failed).toBe(1);
      expect(report.outcomes[0].error).toMatch(/json/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("api.aliases.watch — interval drift correction", () => {
  /** @type {KasaApi} */
  let api;
  beforeAll(async () => {
    api = await createKasaApi();
  });
  afterAll(async () => {
    try {
      await api?.slothlet?.shutdown?.();
    } catch {}
  });

  it("re-applies on each tick when the source is a live-updating function", async () => {
    const plug = await startFakeNamedPlug("V1", "AA:BB:CC:DD:EE:05");
    api.discovery.sweep = async () => [
      { host: "127.0.0.1", port: plug.port, sysInfo: { alias: plug.alias, mac: "AA:BB:CC:DD:EE:05", model: "HS100(US)" } }
    ];
    await api.devices.refresh();
    /** @type {Record<string,string>} */
    let liveMap = { "127.0.0.1": "V1" };
    const w = api.aliases.watch(() => liveMap, { intervalMs: 1000, confirm: false });
    try {
      const firstTick = await nextEvent(w, "tick");
      expect(firstTick.counts.unchanged).toBe(1);
      // Mutate the live map → next tick should rename.
      liveMap = { "127.0.0.1": "V2" };
      const renamed = await nextEvent(w, "renamed", 3000);
      expect(renamed.desired).toBe("V2");
      expect(plug.alias).toBe("V2");
    } finally {
      w.stop();
      await plug.close();
    }
  });

  it("force tick() runs an immediate apply outside the interval", async () => {
    const plug = await startFakeNamedPlug("ImmediateOld", "AA:BB:CC:DD:EE:06");
    api.discovery.sweep = async () => [
      { host: "127.0.0.1", port: plug.port, sysInfo: { alias: plug.alias, mac: "AA:BB:CC:DD:EE:06", model: "HS100(US)" } }
    ];
    await api.devices.refresh();
    const w = api.aliases.watch({ "127.0.0.1": "ImmediateNew" }, {
      intervalMs: 60_000, // long enough we'd time out waiting
      runImmediately: false,
      confirm: false
    });
    try {
      const report = await w.tick();
      expect(report.counts.renamed).toBe(1);
      expect(plug.alias).toBe("ImmediateNew");
    } finally {
      w.stop();
      await plug.close();
    }
  });

  it("stop() halts the interval and emits 'stop'", async () => {
    const w = api.aliases.watch({}, { intervalMs: 60_000, runImmediately: false });
    try {
      const stopped = nextEvent(w, "stop", 2000);
      w.stop();
      await stopped;
      // Idempotent
      w.stop();
    } catch (err) {
      throw err;
    }
  });
});
