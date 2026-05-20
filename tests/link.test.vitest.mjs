/**
 * MonitorEvent.cause tagging + api.link helper tests.
 *
 * Two angles:
 *   - Direct: api.switch.on(target) → wait for the watcher's "on" event →
 *     assert cause === "self". External flip (server-state mutation without
 *     a command) → cause === "external".
 *   - High-level: api.link([s1, s2]) gangs the two. External flip on s1 →
 *     "propagate" event fires, s2 follows. Subsequent flips don't loop.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createKasaApi } from "../src/index.mts";
import { startFakeTcp } from "./_helpers.mjs";

/** @typedef {Awaited<ReturnType<typeof createKasaApi>>} KasaApi */

/** A fake plug that tracks its own relay state. */
async function startFakePlug() {
  let state = 0;
  const server = await startFakeTcp((cmd) => {
    if (cmd.system?.set_relay_state) {
      state = cmd.system.set_relay_state.state;
      return { system: { set_relay_state: { err_code: 0 } } };
    }
    if (cmd.system?.get_sysinfo) {
      return { system: { get_sysinfo: { relay_state: state, on_time: 0, active_mode: "none" } } };
    }
    return { err: 1 };
  });
  return {
    ...server,
    get state() {
      return state;
    },
    setState(v) {
      state = v;
    }
  };
}

/** Wait for the next `event` on an EventEmitter, resolving with the payload. */
function nextEvent(emitter, event, timeoutMs = 2000) {
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

describe("MonitorEvent.cause — self vs external attribution", () => {
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

  it("baseline 'state' event has cause: 'unknown'", async () => {
    const plug = await startFakePlug();
    const w = api.monitor.watch({ host: "127.0.0.1", port: plug.port }, { intervalMs: 250 });
    try {
      const ev = await nextEvent(w, "state");
      expect(ev.cause).toBe("unknown");
    } finally {
      w.stop();
      await plug.close();
    }
  });

  it("transition driven by api.switch.on(...) has cause: 'self'", async () => {
    const plug = await startFakePlug();
    const target = { host: "127.0.0.1", port: plug.port };
    const w = api.monitor.watch(target, { intervalMs: 250 });
    try {
      await nextEvent(w, "state"); // wait for baseline
      const seenOn = nextEvent(w, "on", 5000);
      const r = await api.switch.on(target);
      expect(r.ok).toBe(true);
      const ev = await seenOn;
      expect(ev.changedTo).toBe(1);
      expect(ev.cause).toBe("self");
    } finally {
      w.stop();
      await plug.close();
    }
  });

  it("transition from external state mutation has cause: 'external'", async () => {
    const plug = await startFakePlug();
    const target = { host: "127.0.0.1", port: plug.port };
    const w = api.monitor.watch(target, { intervalMs: 250 });
    try {
      await nextEvent(w, "state");
      const seenOn = nextEvent(w, "on", 5000);
      // External flip — no command via the API instance.
      plug.setState(1);
      const ev = await seenOn;
      expect(ev.changedTo).toBe(1);
      expect(ev.cause).toBe("external");
    } finally {
      w.stop();
      await plug.close();
    }
  });

  it("self stamp is one-shot — a second transition without a fresh command is 'external'", async () => {
    const plug = await startFakePlug();
    const target = { host: "127.0.0.1", port: plug.port };
    const w = api.monitor.watch(target, { intervalMs: 250 });
    try {
      await nextEvent(w, "state");

      // Self-command on → expect cause: 'self'
      const seenOn = nextEvent(w, "on", 5000);
      await api.switch.on(target);
      const onEv = await seenOn;
      expect(onEv.cause).toBe("self");

      // External flip back to off → expect cause: 'external' (no fresh command)
      const seenOff = nextEvent(w, "off", 5000);
      plug.setState(0);
      const offEv = await seenOff;
      expect(offEv.cause).toBe("external");
    } finally {
      w.stop();
      await plug.close();
    }
  });
});

describe("api.link — device-linking helper", () => {
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

  it("propagates an external 'on' from one device to the rest, without feedback loop", async () => {
    const a = await startFakePlug();
    const b = await startFakePlug();
    const c = await startFakePlug();
    const refs = [
      { host: "127.0.0.1", port: a.port },
      { host: "127.0.0.1", port: b.port },
      { host: "127.0.0.1", port: c.port }
    ];
    const group = api.link(refs, { pollMs: 200 });
    try {
      // First propagation — wait for it.
      const propagated = nextEvent(group, "propagate", 5000);
      // External flip on `a` — the watcher should catch it and propagate.
      await new Promise((r) => setTimeout(r, 300)); // let baselines settle
      a.setState(1);
      const p = await propagated;
      expect(p.verb).toBe("on");
      expect(p.targets).toHaveLength(2);
      // Bulk results should all be ok.
      expect(p.results.every((r) => r.ok)).toBe(true);
      // States should be all-on shortly after.
      await new Promise((r) => setTimeout(r, 400));
      expect(a.state).toBe(1);
      expect(b.state).toBe(1);
      expect(c.state).toBe(1);

      // Now turn `b` off externally — link should propagate "off" to a and c.
      const offProp = nextEvent(group, "propagate", 5000);
      b.setState(0);
      const p2 = await offProp;
      expect(p2.verb).toBe("off");
      await new Promise((r) => setTimeout(r, 400));
      expect(a.state).toBe(0);
      expect(b.state).toBe(0);
      expect(c.state).toBe(0);
    } finally {
      group.stop();
      await a.close();
      await b.close();
      await c.close();
    }
  });

  it("stop() halts all watchers and emits 'stop'", async () => {
    const a = await startFakePlug();
    const b = await startFakePlug();
    const group = api.link(
      [
        { host: "127.0.0.1", port: a.port },
        { host: "127.0.0.1", port: b.port }
      ],
      { pollMs: 200 }
    );
    try {
      const stopped = nextEvent(group, "stop", 2000);
      group.stop();
      await stopped;
      // Idempotent — calling again is a no-op.
      group.stop();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("opts.onAny:'none' suppresses on-propagation but still emits the watcher event", async () => {
    const a = await startFakePlug();
    const b = await startFakePlug();
    const group = api.link(
      [
        { host: "127.0.0.1", port: a.port },
        { host: "127.0.0.1", port: b.port }
      ],
      { pollMs: 200, onAny: "none" }
    );
    let propagated = false;
    group.on("propagate", () => (propagated = true));
    try {
      await new Promise((r) => setTimeout(r, 300));
      a.setState(1);
      await new Promise((r) => setTimeout(r, 600));
      expect(a.state).toBe(1);
      expect(b.state).toBe(0); // not propagated
      expect(propagated).toBe(false);
    } finally {
      group.stop();
      await a.close();
      await b.close();
    }
  });
});
