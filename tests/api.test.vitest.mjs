import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createKasaApi } from "../src/index.mts";
import { startFakeTcp, startFakeUdp } from "./_helpers.mjs";

/** @typedef {Awaited<ReturnType<typeof createKasaApi>>} KasaApi */

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

/**
 * Resolve with the first `event` whose payload matches `predicate`.
 * Cleans up its own listener; rejects on timeout.
 */
function nextOp(event, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      api.events.off(event, handler);
      reject(new Error(`timed out waiting for events "${event}"`));
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

describe("slothlet API surface", () => {
  it("exposes every module namespace", () => {
    expect(typeof api.protocol.send).toBe("function");
    expect(typeof api.discovery.discover).toBe("function");
    expect(typeof api.discovery.sweep).toBe("function");
    expect(typeof api.events.on).toBe("function");
    expect(typeof api.events.run).toBe("function");
    expect(typeof api.device.getSysInfo).toBe("function");
    expect(typeof api.plug.on).toBe("function");
    expect(typeof api.switch.toggle).toBe("function");
    expect(typeof api.dimmer.setBrightness).toBe("function");
    expect(typeof api.motion.getPirConfig).toBe("function");
    expect(typeof api.bulb.setColor).toBe("function");
    expect(typeof api.energy.getRealtime).toBe("function");
    expect(typeof api.schedule.getRules).toBe("function");
    expect(typeof api.monitor.watch).toBe("function");
    expect(typeof api.bulk.plug.on).toBe("function");
    expect(typeof api.bulk.dimmer.setBrightness).toBe("function");
    expect(typeof api.signal.report).toBe("function");
  });
});

describe("OpResult contract", () => {
  it("a successful command resolves to ok:true with the device value and never throws", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const r = await api.plug.on({ host: "127.0.0.1", port: server.port });
      expect(r.ok).toBe(true);
      expect(r.op).toBe("plug.on");
      expect(r.host).toBe("127.0.0.1");
      expect(r.target).toEqual({ host: "127.0.0.1", port: server.port });
      expect(r.reachable).toBe(true);
      expect(typeof r.durationMs).toBe("number");
    } finally {
      await server.close();
    }
  });

  it("an unreachable device resolves to ok:false, reachable:false (no throw)", async () => {
    const r = await api.plug.on({ host: "127.0.0.1", port: 1, timeoutMs: 400 });
    expect(r.ok).toBe(false);
    expect(r.reachable).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  it("a device-side error resolves to ok:false but reachable:true", async () => {
    const server = await startFakeTcp(() => ({
      system: { set_relay_state: { err_code: -1, err_msg: "denied" } }
    }));
    try {
      const r = await api.plug.on({ host: "127.0.0.1", port: server.port });
      expect(r.ok).toBe(false);
      expect(r.reachable).toBe(true);
      expect(r.error).toMatch(/denied/);
    } finally {
      await server.close();
    }
  });

  it("invalid input resolves to ok:false instead of throwing", async () => {
    const r = await api.dimmer.setBrightness({ host: "127.0.0.1", port: 9999 }, 0);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1\.\.100/);
  });
});

describe("api.device", () => {
  it("getSysInfo returns the device's sysinfo as value", async () => {
    const sysinfo = { alias: "Living Room", model: "HS110(US)", relay_state: 1 };
    const server = await startFakeTcp(() => ({ system: { get_sysinfo: sysinfo } }));
    try {
      const r = await api.device.getSysInfo({ host: "127.0.0.1", port: server.port });
      expect(r.ok).toBe(true);
      expect(r.value).toEqual(sysinfo);
    } finally {
      await server.close();
    }
  });

  it("setAlias sends system.set_dev_alias", async () => {
    const server = await startFakeTcp(() => ({ system: { set_dev_alias: { err_code: 0 } } }));
    try {
      const r = await api.device.setAlias({ host: "127.0.0.1", port: server.port }, "New Name");
      expect(r.ok).toBe(true);
      expect(server.received[0]).toEqual({ system: { set_dev_alias: { alias: "New Name" } } });
    } finally {
      await server.close();
    }
  });

  it("setLedOff inverts the boolean to TP-Link's `off` flag", async () => {
    const server = await startFakeTcp(() => ({ system: { set_led_off: { err_code: 0 } } }));
    try {
      await api.device.setLedOff({ host: "127.0.0.1", port: server.port }, true);
      expect(server.received[0]).toEqual({ system: { set_led_off: { off: 1 } } });
    } finally {
      await server.close();
    }
  });
});

describe("api.plug", () => {
  it("on() sends set_relay_state:1", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      await api.plug.on({ host: "127.0.0.1", port: server.port });
      expect(server.received[0]).toEqual({ system: { set_relay_state: { state: 1 } } });
    } finally {
      await server.close();
    }
  });

  it("off() sends set_relay_state:0", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      await api.plug.off({ host: "127.0.0.1", port: server.port });
      expect(server.received[0]).toEqual({ system: { set_relay_state: { state: 0 } } });
    } finally {
      await server.close();
    }
  });

  it("toggle() flips the reported state; value is the new state", async () => {
    let relayState = /** @type {0|1} */ (0);
    const server = await startFakeTcp((cmd) => {
      if (cmd.system?.get_sysinfo) return { system: { get_sysinfo: { relay_state: relayState } } };
      if (cmd.system?.set_relay_state) {
        relayState = /** @type {0|1} */ (cmd.system.set_relay_state.state);
        return { system: { set_relay_state: { err_code: 0 } } };
      }
      return { err: 1 };
    });
    try {
      const r = await api.plug.toggle({ host: "127.0.0.1", port: server.port });
      expect(r.ok).toBe(true);
      expect(r.value).toBe(1);
      expect(relayState).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("setChildState includes a child_ids context", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      await api.plug.setChildState(
        { host: "127.0.0.1", port: server.port },
        ["80060000abcd0001", "80060000abcd0002"],
        true
      );
      expect(server.received[0]).toEqual({
        system: { set_relay_state: { state: 1 } },
        context: { child_ids: ["80060000abcd0001", "80060000abcd0002"] }
      });
    } finally {
      await server.close();
    }
  });

  it("setChildState with an empty id list resolves to ok:false", async () => {
    const r = await api.plug.setChildState({ host: "127.0.0.1", port: 9999 }, [], true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least one/);
  });
});

describe("api.bulb", () => {
  const NS = "smartlife.iot.smartbulb.lightingservice";

  it("setBrightness sends the bulb-specific transition payload", async () => {
    const server = await startFakeTcp(() => ({
      [NS]: { transition_light_state: { err_code: 0, brightness: 50 } }
    }));
    try {
      await api.bulb.setBrightness({ host: "127.0.0.1", port: server.port }, 50, 500);
      expect(server.received[0][NS]?.transition_light_state).toMatchObject({
        on_off: 1,
        brightness: 50,
        transition_period: 500,
        ignore_default: 1
      });
    } finally {
      await server.close();
    }
  });

  it("setColor zeroes color_temp so the bulb leaves white-temp mode", async () => {
    const server = await startFakeTcp(() => ({ [NS]: { transition_light_state: { err_code: 0 } } }));
    try {
      await api.bulb.setColor(
        { host: "127.0.0.1", port: server.port },
        { hue: 200, saturation: 80, value: 70 }
      );
      expect(server.received[0][NS]?.transition_light_state).toMatchObject({
        on_off: 1,
        color_temp: 0,
        hue: 200,
        saturation: 80,
        brightness: 70
      });
    } finally {
      await server.close();
    }
  });

  it("out-of-range brightness resolves to ok:false", async () => {
    const r = await api.bulb.setBrightness({ host: "127.0.0.1", port: 9999 }, 200);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1\.\.100/);
  });

  it("out-of-range hue resolves to ok:false", async () => {
    const r = await api.bulb.setColor({ host: "127.0.0.1", port: 9999 }, { hue: 999, saturation: 50 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/0\.\.360/);
  });
});

describe("api.energy", () => {
  it("getRealtime returns the emeter snapshot as value", async () => {
    const snap = { voltage_mv: 121000, current_ma: 250, power_mw: 31000, total_wh: 1234 };
    const server = await startFakeTcp(() => ({ emeter: { get_realtime: { ...snap, err_code: 0 } } }));
    try {
      const r = await api.energy.getRealtime({ host: "127.0.0.1", port: server.port });
      expect(r.ok).toBe(true);
      expect(r.value).toMatchObject(snap);
    } finally {
      await server.close();
    }
  });

  it("getDayStats returns the day_list array as value", async () => {
    const days = [
      { year: 2026, month: 5, day: 1, energy_wh: 412 },
      { year: 2026, month: 5, day: 2, energy_wh: 388 }
    ];
    const server = await startFakeTcp(() => ({ emeter: { get_daystat: { day_list: days, err_code: 0 } } }));
    try {
      const r = await api.energy.getDayStats({ host: "127.0.0.1", port: server.port }, 2026, 5);
      expect(r.value).toEqual(days);
    } finally {
      await server.close();
    }
  });

  it("getDayStats with an invalid month resolves to ok:false", async () => {
    const r = await api.energy.getDayStats({ host: "127.0.0.1", port: 9999 }, 2026, 13);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1\.\.12/);
  });
});

describe("api.switch", () => {
  it("on() sends set_relay_state:1 (same protocol as plug)", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      await api.switch.on({ host: "127.0.0.1", port: server.port });
      expect(server.received[0]).toEqual({ system: { set_relay_state: { state: 1 } } });
    } finally {
      await server.close();
    }
  });

  it("toggle() flips the reported relay state", async () => {
    let relayState = /** @type {0|1} */ (1);
    const server = await startFakeTcp((cmd) => {
      if (cmd.system?.get_sysinfo) return { system: { get_sysinfo: { relay_state: relayState } } };
      if (cmd.system?.set_relay_state) {
        relayState = /** @type {0|1} */ (cmd.system.set_relay_state.state);
        return { system: { set_relay_state: { err_code: 0 } } };
      }
      return { err: 1 };
    });
    try {
      const r = await api.switch.toggle({ host: "127.0.0.1", port: server.port });
      expect(r.value).toBe(0);
      expect(relayState).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("api.dimmer", () => {
  const NS = "smartlife.iot.dimmer";

  it("setBrightness sends smartlife.iot.dimmer.set_brightness", async () => {
    const server = await startFakeTcp(() => ({ [NS]: { set_brightness: { err_code: 0 } } }));
    try {
      await api.dimmer.setBrightness({ host: "127.0.0.1", port: server.port }, 60);
      expect(server.received[0]).toEqual({ [NS]: { set_brightness: { brightness: 60 } } });
    } finally {
      await server.close();
    }
  });

  it("setBrightnessTransition sends set_dimmer_transition with mode + duration", async () => {
    const server = await startFakeTcp(() => ({ [NS]: { set_dimmer_transition: { err_code: 0 } } }));
    try {
      await api.dimmer.setBrightnessTransition({ host: "127.0.0.1", port: server.port }, 40, 1500);
      expect(server.received[0]).toEqual({
        [NS]: { set_dimmer_transition: { brightness: 40, mode: "gentle_on_off", duration: 1500 } }
      });
    } finally {
      await server.close();
    }
  });

  it("getParameters returns the dimmer tuning block as value", async () => {
    const params = { minThreshold: 12, fadeOnTime: 1000, fadeOffTime: 1000, err_code: 0 };
    const server = await startFakeTcp(() => ({ [NS]: { get_dimmer_parameters: params } }));
    try {
      const r = await api.dimmer.getParameters({ host: "127.0.0.1", port: server.port });
      expect(r.value).toMatchObject({ minThreshold: 12, fadeOnTime: 1000 });
    } finally {
      await server.close();
    }
  });

  it("setDoubleClickAction includes the preset brightness as `index`", async () => {
    const server = await startFakeTcp(() => ({ [NS]: { set_double_click_action: { err_code: 0 } } }));
    try {
      await api.dimmer.setDoubleClickAction({ host: "127.0.0.1", port: server.port }, "preset", 75);
      expect(server.received[0]).toEqual({ [NS]: { set_double_click_action: { mode: "preset", index: 75 } } });
    } finally {
      await server.close();
    }
  });
});

describe("api.motion", () => {
  const PIR = "smartlife.iot.PIR";
  const LAS = "smartlife.iot.LAS";

  it("getPirConfig reads the PIR sensor config as value", async () => {
    const cfg = { enable: 1, trigger_index: 1, cold_time: 60000, array: [80, 50, 20], err_code: 0 };
    const server = await startFakeTcp(() => ({ [PIR]: { get_config: cfg } }));
    try {
      const r = await api.motion.getPirConfig({ host: "127.0.0.1", port: server.port });
      expect(r.value).toMatchObject({ enable: 1, trigger_index: 1 });
    } finally {
      await server.close();
    }
  });

  it("setPirEnabled maps the boolean to PIR.set_enable", async () => {
    const server = await startFakeTcp(() => ({ [PIR]: { set_enable: { err_code: 0 } } }));
    try {
      await api.motion.setPirEnabled({ host: "127.0.0.1", port: server.port }, false);
      expect(server.received[0]).toEqual({ [PIR]: { set_enable: { enable: 0 } } });
    } finally {
      await server.close();
    }
  });

  it("setAmbientEnabled targets the LAS namespace", async () => {
    const server = await startFakeTcp(() => ({ [LAS]: { set_enable: { err_code: 0 } } }));
    try {
      await api.motion.setAmbientEnabled({ host: "127.0.0.1", port: server.port }, true);
      expect(server.received[0]).toEqual({ [LAS]: { set_enable: { enable: 1 } } });
    } finally {
      await server.close();
    }
  });

  it("a negative sensitivity index resolves to ok:false", async () => {
    const r = await api.motion.setPirSensitivity({ host: "127.0.0.1", port: 9999 }, -1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-negative/);
  });
});

describe("api.events", () => {
  it("emits op / <path> / success with a target-carrying payload", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const opSeen = nextOp("op", (e) => e.op === "plug.on");
      const pathSeen = nextOp("plug.on");
      const successSeen = nextOp("success", (e) => e.op === "plug.on");
      await api.plug.on({ host: "127.0.0.1", port: server.port });

      const ev = await pathSeen;
      expect(ev.module).toBe("plug");
      expect(ev.method).toBe("on");
      expect(ev.ok).toBe(true);
      expect(ev.host).toBe("127.0.0.1");
      expect(ev.target).toEqual({ host: "127.0.0.1", port: server.port });
      expect(typeof ev.durationMs).toBe("number");
      expect(typeof ev.at).toBe("number");
      await opSeen;
      await successSeen;
    } finally {
      await server.close();
    }
  });

  it("emits an error event (no throw) when a command fails", async () => {
    const errSeen = nextOp("error", (e) => e.op === "plug.off");
    await api.plug.off({ host: "127.0.0.1", port: 1, timeoutMs: 400 });
    const ev = await errSeen;
    expect(ev.ok).toBe(false);
    expect(ev.reachable).toBe(false);
    expect(ev.host).toBe("127.0.0.1");
    expect(ev.error).toBeTruthy();
  });
});

describe("api.bulk", () => {
  it("runs a command across many targets, one OpResult each", async () => {
    const a = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    const b = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const results = await api.bulk.plug.on([
        { host: "127.0.0.1", port: a.port },
        { host: "127.0.0.1", port: b.port }
      ]);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.map((r) => r.op)).toEqual(["plug.on", "plug.on"]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("reports a non-responder per-device without failing the batch", async () => {
    const live = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const results = await api.bulk.plug.on([
        { host: "127.0.0.1", port: live.port },
        { host: "127.0.0.1", port: 1, timeoutMs: 400 }
      ]);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(false);
      expect(results[1].reachable).toBe(false);
      expect(results[1].host).toBe("127.0.0.1");
    } finally {
      await live.close();
    }
  });

  it("forwards extra args (bulk.dimmer.setBrightness)", async () => {
    const NS = "smartlife.iot.dimmer";
    const server = await startFakeTcp(() => ({ [NS]: { set_brightness: { err_code: 0 } } }));
    try {
      const results = await api.bulk.dimmer.setBrightness([{ host: "127.0.0.1", port: server.port }], 55);
      expect(results[0].ok).toBe(true);
      expect(server.received[0]).toEqual({ [NS]: { set_brightness: { brightness: 55 } } });
    } finally {
      await server.close();
    }
  });
});

describe("api.signal", () => {
  it("reports RSSI for a device list, sorted strongest first, weak/offline last", async () => {
    const strong = await startFakeTcp(() => ({
      system: { get_sysinfo: { alias: "Close", model: "HS200(US)", rssi: -45 } }
    }));
    const weak = await startFakeTcp(() => ({
      system: { get_sysinfo: { alias: "Far", model: "HS220(US)", rssi: -78 } }
    }));
    try {
      const report = await api.signal.report({
        devices: [
          { host: "127.0.0.1", port: weak.port },
          { host: "127.0.0.1", port: strong.port },
          { host: "127.0.0.1", port: 1 } // offline
        ],
        timeoutMs: 400
      });
      expect(report).toHaveLength(3);
      expect(report[0]).toMatchObject({ alias: "Close", rssi: -45, quality: "excellent", reachable: true });
      expect(report[1]).toMatchObject({ alias: "Far", rssi: -78, quality: "weak", reachable: true });
      expect(report[2]).toMatchObject({ rssi: null, quality: "unknown", reachable: false });
    } finally {
      await strong.close();
      await weak.close();
    }
  });
});

describe("api.discovery", () => {
  it("discovers a single device against a loopback UDP server", async () => {
    const sysinfo = { alias: "Discovery Plug", model: "HS105(US)", relay_state: 0 };
    const server = await startFakeUdp((cmd) => {
      if (!cmd.system?.get_sysinfo) return null;
      return { system: { get_sysinfo: sysinfo } };
    });
    try {
      const devices = await api.discovery.discover({
        broadcast: "127.0.0.1",
        port: server.port,
        timeoutMs: 500,
        maxDevices: 1
      });
      expect(devices).toHaveLength(1);
      expect(devices[0].host).toBe("127.0.0.1");
      expect(devices[0].sysInfo).toMatchObject({ alias: "Discovery Plug" });
    } finally {
      await server.close();
    }
  });

  it("returns an empty list when no devices respond", async () => {
    const devices = await api.discovery.discover({
      broadcast: "127.0.0.1",
      port: 1,
      timeoutMs: 200
    });
    expect(devices).toEqual([]);
  });
});

describe("api.discovery — sweep (unicast CIDR scan)", () => {
  it("finds devices across a CIDR by unicast probe", async () => {
    const a = await startFakeTcp(
      () => ({ system: { get_sysinfo: { alias: "Device A", model: "HS200(US)" } } }),
      { host: "127.0.0.2" }
    );
    const b = await startFakeTcp(
      () => ({ system: { get_sysinfo: { alias: "Device B", model: "HS220(US)" } } }),
      { host: "127.0.0.3", port: a.port }
    );
    try {
      const devices = await api.discovery.sweep("127.0.0.2/31", {
        port: a.port,
        timeoutMs: 500,
        concurrency: 8
      });
      expect(devices).toHaveLength(2);
      expect(devices.map((d) => d.host)).toEqual(["127.0.0.2", "127.0.0.3"]);
      expect(devices[0].sysInfo).toMatchObject({ alias: "Device A" });
      expect(devices[1].sysInfo).toMatchObject({ alias: "Device B" });
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("returns an empty list when no host in range answers", async () => {
    const devices = await api.discovery.sweep("127.0.0.8/30", {
      port: 1,
      timeoutMs: 300,
      concurrency: 4
    });
    expect(devices).toEqual([]);
  });

  it("refuses to sweep an unreasonably large range", async () => {
    await expect(api.discovery.sweep("10.0.0.0/8")).rejects.toThrow(/refusing to sweep/);
  });

  it("rejects a malformed CIDR", async () => {
    await expect(api.discovery.sweep("10.8.1.0")).rejects.toThrow(/Invalid CIDR/);
  });
});

describe("api.monitor", () => {
  /** Resolve with the first payload of `event`, or reject on timeout. */
  const nextEvent = (emitter, event, timeoutMs = 2000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        emitter.off(event, onEvent);
        reject(new Error(`timed out waiting for "${event}"`));
      }, timeoutMs);
      function onEvent(payload) {
        clearTimeout(timer);
        resolve(payload);
      }
      emitter.once(event, onEvent);
    });

  it("emits a baseline state event, then on/off transitions", async () => {
    let relayState = 0;
    let activeMode = "none";
    const server = await startFakeTcp((cmd) => {
      if (cmd.system?.get_sysinfo) {
        return {
          system: {
            get_sysinfo: { relay_state: relayState, on_time: relayState ? 5 : 0, active_mode: activeMode }
          }
        };
      }
      return { err: 1 };
    });
    const w = api.monitor.watch({ host: "127.0.0.1", port: server.port }, { intervalMs: 50 });
    try {
      const baseline = await nextEvent(w, "state");
      expect(baseline.relayState).toBe(0);
      expect(baseline.changedTo).toBe(null);

      relayState = 1;
      activeMode = "count_down";
      const onEv = await nextEvent(w, "on");
      expect(onEv.changedTo).toBe(1);
      expect(onEv.triggeredBy).toBe("motion");

      relayState = 0;
      activeMode = "none";
      const offEv = await nextEvent(w, "off");
      expect(offEv.changedTo).toBe(0);
    } finally {
      w.stop();
      await server.close();
    }
  });

  it("infers a manual on-transition when no countdown is active", async () => {
    let relayState = 0;
    const server = await startFakeTcp((cmd) => {
      if (cmd.system?.get_sysinfo) {
        return { system: { get_sysinfo: { relay_state: relayState, active_mode: "none" } } };
      }
      return { err: 1 };
    });
    const w = api.monitor.watch({ host: "127.0.0.1", port: server.port }, { intervalMs: 50 });
    try {
      await nextEvent(w, "state");
      relayState = 1;
      const onEv = await nextEvent(w, "on");
      expect(onEv.triggeredBy).toBe("manual");
    } finally {
      w.stop();
      await server.close();
    }
  });

  it("emits error on a failed poll and keeps polling", async () => {
    const w = api.monitor.watch({ host: "127.0.0.1", port: 1, timeoutMs: 200 }, { intervalMs: 50 });
    try {
      const err = await nextEvent(w, "error", 5000);
      expect(err).toBeInstanceOf(Error);
      const err2 = await nextEvent(w, "error", 5000);
      expect(err2).toBeInstanceOf(Error);
    } finally {
      w.stop();
    }
  });

  it("stop() emits stop and halts polling", async () => {
    const server = await startFakeTcp(() => ({ system: { get_sysinfo: { relay_state: 0 } } }));
    const w = api.monitor.watch({ host: "127.0.0.1", port: server.port }, { intervalMs: 50 });
    try {
      await nextEvent(w, "state");
      const stopped = nextEvent(w, "stop", 1000);
      w.stop();
      await stopped;
    } finally {
      await server.close();
    }
  });
});
