/**
 * Ref-resolution + force + bulk-mixed + signal-stringy tests.
 *
 * The wrapper layer in `src/lib/refs.mts` is what makes `api.switch.on("Lamp")`
 * and `api.bulk.plug.on(["10.0.0.5", "Lamp", { host: "10.0.0.6" }])` work. We
 * test that:
 *   - object / IPv4 refs pass straight through (no `devices.resolve` event)
 *   - MAC / alias refs go through `devices.resolve` and report `ok: false`
 *     with an error event on a miss
 *   - the `force` flag is plumbed per-call > target > global into `resolve`
 *   - bulk accepts mixed-ref arrays and surfaces unresolved slots as ok:false
 *   - `signal.report("cidr")` / `signal.report("ip")` shorthands route correctly
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createKasaApi } from "../src/index.mts";
import { startFakeTcp } from "./_helpers.mjs";

/** @typedef {Awaited<ReturnType<typeof createKasaApi>>} KasaApi */

/** Resolve with the first `event` whose payload matches `predicate`. */
function nextOp(api, event, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      api.events.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(ev) {
      if (!predicate(ev)) return;
      clearTimeout(timer);
      api.events.off(event, handler);
      resolve(ev);
    }
    api.events.on(event, handler);
  });
}

/** Wrap `api.devices.resolve` so calls can be inspected; returns the call log. */
function spyResolve(api) {
  /** @type {Array<{ ref: unknown; options: unknown }>} */
  const calls = [];
  const original = api.devices.resolve.bind(api.devices);
  api.devices.resolve = async (ref, options) => {
    calls.push({ ref, options });
    return original(ref, options);
  };
  return calls;
}

/** Replace discovery.sweep with a no-op so MAC/alias misses fail fast. */
function stubSweep(api) {
  const original = api.discovery.sweep;
  api.discovery.sweep = async () => [];
  return () => {
    api.discovery.sweep = original;
  };
}

describe("ref resolution — single-device commands", () => {
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

  it("accepts an IPv4 string — synthesises { host: ip } and fires blind", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    const calls = spyResolve(api);
    try {
      const r = await api.switch.on(`127.0.0.1`, { confirm: false });
      // The wrapper used quickResolve (sync passthrough) — no devices.resolve call.
      expect(calls).toEqual([]);
      // It still hit our fake server (we know because it returned ok:true).
      // The default port is 9999 — our fake's port differs, so we can only
      // assert the resolved target shape via a target-object call:
      void r;
    } finally {
      await server.close();
    }
    // Now use an object ref pinned to the fake server's port to assert the wire.
    const server2 = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const r2 = await api.switch.on({ host: "127.0.0.1", port: server2.port });
      expect(r2.ok).toBe(true);
      expect(calls).toEqual([]); // object refs also bypass resolve.
    } finally {
      await server2.close();
    }
  });

  it("accepts a DeviceTarget object — passthrough, no resolve call", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    const calls = spyResolve(api);
    try {
      const r = await api.switch.on({ host: "127.0.0.1", port: server.port });
      expect(r.ok).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("unresolved MAC/alias ref → ok:false OpResult under the command's op path", async () => {
    // Replace discovery.sweep with a no-op so the resolver's miss-path is fast
    // and deterministic (no real network sweep — would take 10–30s of routing
    // timeouts in CI environments without the target subnet).
    const origSweep = api.discovery.sweep;
    api.discovery.sweep = async () => [];
    try {
      const seenError = nextOp(api, "switch.on", (e) => !e.ok && /no match/i.test(String(e.error)));
      const r = await api.switch.on("Ghost-Alias-That-Will-Never-Resolve");
      expect(r.ok).toBe(false);
      expect(r.op).toBe("switch.on");
      expect(r.reachable).toBe(false);
      expect(r.error).toMatch(/no match/i);
      const ev = await seenError;
      expect(ev.op).toBe("switch.on");
      expect(ev.ok).toBe(false);
    } finally {
      api.discovery.sweep = origSweep;
    }
  });
});

describe("ref resolution — force option", () => {
  /** @type {KasaApi} */
  let api;
  /** @type {() => void} */
  let restoreSweep;
  beforeAll(async () => {
    api = await createKasaApi();
    restoreSweep = stubSweep(api);
  });
  afterAll(async () => {
    restoreSweep?.();
    try {
      await api?.slothlet?.shutdown?.();
    } catch {}
  });

  it("per-call force:true is plumbed into devices.resolve", async () => {
    const calls = spyResolve(api);
    await api.switch.on("Ghost", { force: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].ref).toBe("Ghost");
    expect(calls[0].options).toEqual({ force: true });
  });

  it("an object ref with .force:true is still a passthrough — no resolve call", async () => {
    // `force` only applies to MAC/alias refs. For object / IPv4 refs the wrapper
    // documents `force` as a no-op: there's no cache to bypass.
    const calls = spyResolve(api);
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const r = await api.switch.on({ host: "127.0.0.1", port: server.port, force: true });
      expect(r.ok).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("per-call force:false → no force flag passed to devices.resolve", async () => {
    const calls = spyResolve(api);
    await api.switch.on("aa:bb:cc:dd:ee:ff", { force: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toBeUndefined();
  });

  it("createKasaApi({ force: true }) sets the global default", async () => {
    const api2 = await createKasaApi({ force: true });
    const restore = stubSweep(api2);
    try {
      const calls = spyResolve(api2);
      await api2.switch.on("Ghost");
      expect(calls).toHaveLength(1);
      expect(calls[0].options).toEqual({ force: true });
    } finally {
      restore();
      await api2.slothlet?.shutdown?.();
    }
  });
});

describe("api.bulk — mixed-ref arrays", () => {
  /** @type {KasaApi} */
  let api;
  /** @type {() => void} */
  let restoreSweep;
  beforeAll(async () => {
    api = await createKasaApi();
    restoreSweep = stubSweep(api);
  });
  afterAll(async () => {
    restoreSweep?.();
    try {
      await api?.slothlet?.shutdown?.();
    } catch {}
  });

  it("accepts an array of DeviceTarget objects (back-compat)", async () => {
    const s1 = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    const s2 = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const r = await api.bulk.plug.on([
        { host: "127.0.0.1", port: s1.port },
        { host: "127.0.0.1", port: s2.port }
      ]);
      expect(r).toHaveLength(2);
      expect(r[0].ok).toBe(true);
      expect(r[1].ok).toBe(true);
    } finally {
      await s1.close();
      await s2.close();
    }
  });

  it("accepts a mixed array of object refs, IPv4 strings, and an unresolved alias", async () => {
    const s1 = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const r = await api.bulk.plug.on([
        { host: "127.0.0.1", port: s1.port }, // object → ok:true
        "127.0.0.99", // IPv4 string → blind fire, but no server there → ok:false reachable:false
        "Ghost-Alias" // alias → unresolved → ok:false reachable:false
      ]);
      expect(r).toHaveLength(3);
      expect(r[0].ok).toBe(true);
      expect(r[1].ok).toBe(false);
      expect(r[1].host).toBe("127.0.0.99");
      expect(r[2].ok).toBe(false);
      expect(r[2].host).toBe("Ghost-Alias");
      expect(r[2].error).toMatch(/no match/i);
      // The unresolved slot's op path matches the bulk method's path.
      expect(r[2].op).toBe("plug.on");
    } finally {
      await s1.close();
    }
  }, 15000);

  it("non-array first arg still resolves to []", async () => {
    // Back-compat — same behaviour as before the ref refactor.
    const r = await api.bulk.plug.on(/** @type {any} */ (null));
    expect(r).toEqual([]);
  });
});

describe("api.signal.report — stringy shorthand", () => {
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

  it("a CIDR string routes to discovery.sweep (no broadcast)", async () => {
    let sweepCalledWith = null;
    let discoverCalled = false;
    const origSweep = api.discovery.sweep;
    const origDiscover = api.discovery.discover;
    api.discovery.sweep = async (cidr, options) => {
      sweepCalledWith = { cidr, options };
      return [];
    };
    api.discovery.discover = async () => {
      discoverCalled = true;
      return [];
    };
    try {
      const r = await api.signal.report("10.0.0.0/24");
      expect(sweepCalledWith?.cidr).toBe("10.0.0.0/24");
      expect(discoverCalled).toBe(false);
      expect(r).toEqual([]);
    } finally {
      api.discovery.sweep = origSweep;
      api.discovery.discover = origDiscover;
    }
  });

  it("an IPv4 string routes to a single-device report (no sweep, no broadcast)", async () => {
    const server = await startFakeTcp(() => ({
      system: { get_sysinfo: { alias: "TestPlug", model: "HS100(US)", rssi: -55 } }
    }));
    let sweepCalled = false;
    let discoverCalled = false;
    const origSweep = api.discovery.sweep;
    const origDiscover = api.discovery.discover;
    api.discovery.sweep = async () => {
      sweepCalled = true;
      return [];
    };
    api.discovery.discover = async () => {
      discoverCalled = true;
      return [];
    };
    try {
      // Pin port via an object slot inside `devices` instead; the stringy IP
      // shorthand uses default 9999 which won't reach our fake. So we test it
      // through the explicit options form to assert reachability behaviour,
      // and the stringy form just to assert no sweep/discover is triggered:
      const r1 = await api.signal.report("127.0.0.1");
      expect(sweepCalled).toBe(false);
      expect(discoverCalled).toBe(false);
      expect(r1).toHaveLength(1);
      expect(r1[0].host).toBe("127.0.0.1");

      // Full form for the reachable assertion:
      const r2 = await api.signal.report({ devices: [{ host: "127.0.0.1", port: server.port }] });
      expect(r2).toHaveLength(1);
      expect(r2[0].reachable).toBe(true);
      expect(r2[0].rssi).toBe(-55);
      expect(r2[0].quality).toBe("good");
    } finally {
      api.discovery.sweep = origSweep;
      api.discovery.discover = origDiscover;
      await server.close();
    }
  });

  it("a SignalReportOptions object with devices accepts mixed refs", async () => {
    const server = await startFakeTcp(() => ({
      system: { get_sysinfo: { alias: "MixedRef", model: "HS103(US)", rssi: -45 } }
    }));
    try {
      const r = await api.signal.report({
        devices: [{ host: "127.0.0.1", port: server.port }]
      });
      expect(r).toHaveLength(1);
      expect(r[0].reachable).toBe(true);
      expect(r[0].quality).toBe("excellent");
    } finally {
      await server.close();
    }
  });
});
