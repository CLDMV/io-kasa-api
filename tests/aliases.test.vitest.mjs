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

/**
 * Build a fake multi-outlet strip (HS300 / KP200-style) with N children.
 * The strip routes set_dev_alias to a specific child when the request
 * carries a context.child_ids block, otherwise to the parent.
 */
async function startFakeStrip(parentAlias, mac, childAliases) {
  let alias = parentAlias;
  /** @type {Array<{ id: string; alias: string; state: 0 | 1 }>} */
  const children = childAliases.map((a, i) => ({ id: `STRIP-CHILD-${i.toString().padStart(2, "0")}`, alias: a, state: 0 }));
  const server = await startFakeTcp((cmd) => {
    if (cmd.system?.set_dev_alias) {
      const childId = cmd.context?.child_ids?.[0];
      if (childId) {
        const target = children.find((c) => c.id === childId);
        if (target) target.alias = cmd.system.set_dev_alias.alias;
      } else {
        alias = cmd.system.set_dev_alias.alias;
      }
      return { system: { set_dev_alias: { err_code: 0 } } };
    }
    if (cmd.system?.get_sysinfo) {
      return {
        system: {
          get_sysinfo: {
            alias,
            mac,
            model: "KP200(US)",
            child_num: children.length,
            children: children.map((c) => ({ ...c }))
          }
        }
      };
    }
    return { err: 1 };
  });
  return {
    ...server,
    get parentAlias() {
      return alias;
    },
    childAlias(i) {
      return children[i]?.alias;
    },
    childId(i) {
      return children[i]?.id;
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

  it("renames a child outlet via 'host/<index>' key", async () => {
    const strip = await startFakeStrip("TP-LINK_Smart Plug_57A5", "AA:BB:CC:DD:EE:50", ["Old Top", "Old Bottom"]);
    api.discovery.sweep = async () => [
      {
        host: "127.0.0.1",
        port: strip.port,
        sysInfo: {
          alias: "TP-LINK_Smart Plug_57A5",
          mac: "AA:BB:CC:DD:EE:50",
          model: "KP200(US)",
          child_num: 2,
          children: [
            { id: strip.childId(0), alias: "Old Top", state: 0 },
            { id: strip.childId(1), alias: "Old Bottom", state: 0 }
          ]
        }
      }
    ];
    await api.devices.refresh();
    try {
      const report = await api.aliases.apply(
        {
          "127.0.0.1/0": "LVR - SW - Top Plug",
          "127.0.0.1/1": "LVR - SW - Bottom Plug"
        },
        { confirm: false }
      );
      expect(report.counts.renamed).toBe(2);
      expect(report.outcomes[0].child).toBe(strip.childId(0));
      expect(report.outcomes[1].child).toBe(strip.childId(1));
      expect(strip.childAlias(0)).toBe("LVR - SW - Top Plug");
      expect(strip.childAlias(1)).toBe("LVR - SW - Bottom Plug");
      // Parent's own alias is untouched.
      expect(strip.parentAlias).toBe("TP-LINK_Smart Plug_57A5");
    } finally {
      await strip.close();
    }
  });

  it("renames a child by its full child ID (instead of index)", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:EE:60", ["Outlet A", "Outlet B"]);
    api.discovery.sweep = async () => [
      {
        host: "127.0.0.1",
        port: strip.port,
        sysInfo: {
          alias: "Strip",
          mac: "AA:BB:CC:DD:EE:60",
          model: "KP200(US)",
          child_num: 2,
          children: [
            { id: strip.childId(0), alias: "Outlet A", state: 0 },
            { id: strip.childId(1), alias: "Outlet B", state: 0 }
          ]
        }
      }
    ];
    await api.devices.refresh();
    try {
      const map = {};
      map[`127.0.0.1/${strip.childId(1)}`] = "Renamed via ID";
      const report = await api.aliases.apply(map, { confirm: false });
      expect(report.counts.renamed).toBe(1);
      expect(strip.childAlias(1)).toBe("Renamed via ID");
      expect(strip.childAlias(0)).toBe("Outlet A");
    } finally {
      await strip.close();
    }
  });

  it("'/N' key with no matching child resolves to missing", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:EE:70", ["A", "B"]);
    api.discovery.sweep = async () => [
      {
        host: "127.0.0.1",
        port: strip.port,
        sysInfo: {
          alias: "Strip",
          mac: "AA:BB:CC:DD:EE:70",
          model: "KP200(US)",
          child_num: 2,
          children: [
            { id: strip.childId(0), alias: "A", state: 0 },
            { id: strip.childId(1), alias: "B", state: 0 }
          ]
        }
      }
    ];
    await api.devices.refresh();
    try {
      const report = await api.aliases.apply({ "127.0.0.1/9": "Phantom" });
      expect(report.counts.missing).toBe(1);
      expect(report.outcomes[0].error).toMatch(/no child outlet/i);
    } finally {
      await strip.close();
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
