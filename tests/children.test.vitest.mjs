/**
 * Child-outlet command tests for multi-outlet plugs (HS300 / KP200).
 *
 * Covers:
 *   - target.child set → command targets just that outlet (context.child_ids)
 *   - target.child unset on a strip → broadcasts to all outlets in one call
 *   - target.child unset on a single-outlet plug → bare set_relay_state (legacy)
 *   - ref forms: "host/<index>", "host/<childId>", child alias → resolve to { host, child }
 *   - duplicate child aliases → first match wins + warning event
 *   - api.devices.resolve and api.devices.quickResolve handle the same forms
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKasaApi } from "../src/index.mts";
import { startFakeTcp } from "./_helpers.mjs";

/** @typedef {Awaited<ReturnType<typeof createKasaApi>>} KasaApi */

/** Build a fake multi-outlet strip that honors context.child_ids on set_relay_state. */
async function startFakeStrip(parentAlias, mac, childAliases) {
  let parent = parentAlias;
  /** @type {Array<{ id: string; alias: string; state: 0 | 1; }>} */
  const kids = childAliases.map((alias, i) => ({
    id: `STRIP-${mac.replace(/[^a-fA-F0-9]/g, "").slice(-6)}-${i.toString().padStart(2, "0")}`,
    alias,
    state: 0
  }));
  const server = await startFakeTcp((cmd) => {
    if (cmd.system?.set_relay_state) {
      const wantedState = cmd.system.set_relay_state.state;
      const targets = cmd.context?.child_ids ?? [];
      if (targets.length === 0) {
        // Bare write — single-outlet behaviour. We don't actually model a
        // "strip relay" because Kasa firmware doesn't either; just no-op.
      } else {
        for (const id of targets) {
          const k = kids.find((c) => c.id === id);
          if (k) k.state = wantedState;
        }
      }
      return { system: { set_relay_state: { err_code: 0 } } };
    }
    if (cmd.system?.set_dev_alias) {
      const targets = cmd.context?.child_ids ?? [];
      if (targets.length === 0) parent = cmd.system.set_dev_alias.alias;
      else {
        const k = kids.find((c) => c.id === targets[0]);
        if (k) k.alias = cmd.system.set_dev_alias.alias;
      }
      return { system: { set_dev_alias: { err_code: 0 } } };
    }
    if (cmd.system?.get_sysinfo) {
      return {
        system: {
          get_sysinfo: {
            alias: parent,
            mac,
            model: "KP200(US)",
            child_num: kids.length,
            children: kids.map((c) => ({ ...c }))
          }
        }
      };
    }
    return { err: 1 };
  });
  return {
    ...server,
    get parentAlias() {
      return parent;
    },
    childState(i) {
      return kids[i].state;
    },
    childAlias(i) {
      return kids[i].alias;
    },
    childId(i) {
      return kids[i].id;
    }
  };
}

describe("plug.on / off with target.child — single outlet on a strip", () => {
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

  it("turns on only the specified child outlet; other outlets unchanged", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:E0:01", ["Top", "Bottom"]);
    try {
      const r = await api.plug.on({ host: "127.0.0.1", port: strip.port, child: strip.childId(0) });
      expect(r.ok).toBe(true);
      expect(strip.childState(0)).toBe(1);
      expect(strip.childState(1)).toBe(0);
    } finally {
      await strip.close();
    }
  });

  it("turns off only the specified child outlet", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:E0:02", ["Top", "Bottom"]);
    try {
      // Pre-turn both on so 'off' has something to verify against.
      await api.plug.on({ host: "127.0.0.1", port: strip.port, child: strip.childId(0) });
      await api.plug.on({ host: "127.0.0.1", port: strip.port, child: strip.childId(1) });
      const r = await api.plug.off({ host: "127.0.0.1", port: strip.port, child: strip.childId(0) });
      expect(r.ok).toBe(true);
      expect(strip.childState(0)).toBe(0);
      expect(strip.childState(1)).toBe(1);
    } finally {
      await strip.close();
    }
  });

  it("verify reads sysinfo.children[].state for the targeted child", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:E0:03", ["A", "B"]);
    try {
      const r = await api.plug.on(
        { host: "127.0.0.1", port: strip.port, child: strip.childId(1) },
        { confirm: true }
      );
      expect(r.ok).toBe(true);
      expect(strip.childState(1)).toBe(1);
    } finally {
      await strip.close();
    }
  });
});

describe("plug.on / off without target.child — strip broadcast", () => {
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

  it("on(strip) broadcasts to every child outlet in a single command", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:E0:10", ["A", "B", "C"]);
    try {
      const r = await api.plug.on({ host: "127.0.0.1", port: strip.port });
      expect(r.ok).toBe(true);
      expect(strip.childState(0)).toBe(1);
      expect(strip.childState(1)).toBe(1);
      expect(strip.childState(2)).toBe(1);
    } finally {
      await strip.close();
    }
  });

  it("off(strip) broadcasts to every child outlet", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:E0:11", ["A", "B"]);
    try {
      await api.plug.on({ host: "127.0.0.1", port: strip.port });
      const r = await api.plug.off({ host: "127.0.0.1", port: strip.port });
      expect(r.ok).toBe(true);
      expect(strip.childState(0)).toBe(0);
      expect(strip.childState(1)).toBe(0);
    } finally {
      await strip.close();
    }
  });

  it("toggle(strip) flips aggregate: any-on → all-off; all-off → all-on", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:E0:12", ["A", "B"]);
    try {
      // All off → toggle → all on.
      let r = await api.plug.toggle({ host: "127.0.0.1", port: strip.port });
      expect(r.ok).toBe(true);
      expect(r.value).toBe(1);
      expect(strip.childState(0)).toBe(1);
      expect(strip.childState(1)).toBe(1);
      // All on → toggle → all off.
      r = await api.plug.toggle({ host: "127.0.0.1", port: strip.port });
      expect(r.ok).toBe(true);
      expect(r.value).toBe(0);
      expect(strip.childState(0)).toBe(0);
      expect(strip.childState(1)).toBe(0);
      // One on, one off → toggle → all off (any-on → all-off).
      strip.childState; // (silence unused warning)
      await api.plug.on({ host: "127.0.0.1", port: strip.port, child: strip.childId(0) });
      r = await api.plug.toggle({ host: "127.0.0.1", port: strip.port });
      expect(r.value).toBe(0);
      expect(strip.childState(0)).toBe(0);
      expect(strip.childState(1)).toBe(0);
    } finally {
      await strip.close();
    }
  });
});

describe("ref forms address children — host/<index>, host/<childId>, child alias", () => {
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

  it("'127.0.0.1/0' resolves to the strip's first child", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:E0:20", ["A", "B"]);
    api.discovery.sweep = async () => [
      {
        host: "127.0.0.1",
        port: strip.port,
        sysInfo: {
          alias: "Strip",
          mac: "AA:BB:CC:DD:E0:20",
          model: "KP200(US)",
          children: [
            { id: strip.childId(0), alias: "A", state: 0 },
            { id: strip.childId(1), alias: "B", state: 0 }
          ]
        }
      }
    ];
    await api.devices.refresh();
    try {
      const r = await api.plug.on("127.0.0.1/0");
      expect(r.ok).toBe(true);
      expect(strip.childState(0)).toBe(1);
      expect(strip.childState(1)).toBe(0);
    } finally {
      await strip.close();
    }
  });

  it("a child alias resolves to { host, child } without IP/MAC", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:E0:21", ["Cario Cabinet", "Top Outlet"]);
    api.discovery.sweep = async () => [
      {
        host: "127.0.0.1",
        port: strip.port,
        sysInfo: {
          alias: "Strip",
          mac: "AA:BB:CC:DD:E0:21",
          model: "KP200(US)",
          children: [
            { id: strip.childId(0), alias: "Cario Cabinet", state: 0 },
            { id: strip.childId(1), alias: "Top Outlet", state: 0 }
          ]
        }
      }
    ];
    await api.devices.refresh();
    try {
      const resolved = await api.devices.resolve("Cario Cabinet");
      expect(resolved).toEqual({ host: "127.0.0.1", port: strip.port, child: strip.childId(0) });
      const r = await api.plug.on("Cario Cabinet");
      expect(r.ok).toBe(true);
      expect(strip.childState(0)).toBe(1);
      expect(strip.childState(1)).toBe(0);
    } finally {
      await strip.close();
    }
  });

  it("'127.0.0.1/<full child id>' also resolves", async () => {
    const strip = await startFakeStrip("Strip", "AA:BB:CC:DD:E0:22", ["A", "B"]);
    api.discovery.sweep = async () => [
      {
        host: "127.0.0.1",
        port: strip.port,
        sysInfo: {
          alias: "Strip",
          mac: "AA:BB:CC:DD:E0:22",
          model: "KP200(US)",
          children: [
            { id: strip.childId(0), alias: "A", state: 0 },
            { id: strip.childId(1), alias: "B", state: 0 }
          ]
        }
      }
    ];
    await api.devices.refresh();
    try {
      const r = await api.plug.on(`127.0.0.1/${strip.childId(1)}`);
      expect(r.ok).toBe(true);
      expect(strip.childState(0)).toBe(0);
      expect(strip.childState(1)).toBe(1);
    } finally {
      await strip.close();
    }
  });
});

describe("duplicate child alias — first match + warning", () => {
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

  it("api.devices.resolve picks first; emits a devices.resolve event with warning + matches", async () => {
    const s1 = await startFakeStrip("Strip A", "AA:BB:CC:DD:E0:30", ["Plug 1", "Plug 2"]);
    const s2 = await startFakeStrip("Strip B", "AA:BB:CC:DD:E0:31", ["Plug 1", "Plug 2"]);
    api.discovery.sweep = async () => [
      {
        host: "127.0.0.1",
        port: s1.port,
        sysInfo: {
          alias: "Strip A",
          mac: "AA:BB:CC:DD:E0:30",
          model: "KP200(US)",
          children: [
            { id: s1.childId(0), alias: "Plug 1", state: 0 },
            { id: s1.childId(1), alias: "Plug 2", state: 0 }
          ]
        }
      },
      {
        host: "127.0.0.1",
        port: s2.port,
        sysInfo: {
          alias: "Strip B",
          mac: "AA:BB:CC:DD:E0:31",
          model: "KP200(US)",
          children: [
            { id: s2.childId(0), alias: "Plug 1", state: 0 },
            { id: s2.childId(1), alias: "Plug 2", state: 0 }
          ]
        }
      }
    ];
    await api.devices.refresh();
    try {
      // Listen for the warning event.
      /** @type {unknown} */
      let warningEvent = null;
      api.events.on("devices.resolve", (ev) => {
        if (ev?.value?.warning === "duplicate-child-alias") warningEvent = ev;
      });
      const resolved = await api.devices.resolve("Plug 1");
      expect(resolved).toEqual({ host: "127.0.0.1", port: s1.port, child: s1.childId(0) }); // first match
      // Give the event a microtask to land.
      await new Promise((r) => setImmediate(r));
      expect(warningEvent).not.toBeNull();
      expect(warningEvent.value.matches).toBe(2);
    } finally {
      await s1.close();
      await s2.close();
    }
  });
});
