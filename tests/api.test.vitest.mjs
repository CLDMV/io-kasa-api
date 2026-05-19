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

/** Resolve with the first `event` whose payload matches `predicate`; cleans up. */
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

describe("slothlet API surface (nested resource tree)", () => {
  it("exposes the nested endpoints", () => {
    expect(typeof api.device.info.get).toBe("function");
    expect(typeof api.device.alias.set).toBe("function");
    expect(typeof api.device.reboot).toBe("function");
    expect(typeof api.plug.power.get).toBe("function");
    expect(typeof api.plug.on).toBe("function");
    expect(typeof api.plug.children.set).toBe("function");
    expect(typeof api.switch.toggle).toBe("function");
    expect(typeof api.dimmer.brightness.set).toBe("function");
    expect(typeof api.dimmer.fade.on.set).toBe("function");
    expect(typeof api.motion.pir.get).toBe("function");
    expect(typeof api.motion.pir.sensitivity.set).toBe("function");
    expect(typeof api.motion.ambient.enabled.set).toBe("function");
    expect(typeof api.bulb.color.set).toBe("function");
    expect(typeof api.energy.realtime.get).toBe("function");
    expect(typeof api.energy.stats.daily.get).toBe("function");
    expect(typeof api.schedule.rules.clear).toBe("function");
    expect(typeof api.monitor.watch).toBe("function");
    expect(typeof api.events.run).toBe("function");
    expect(typeof api.signal.report).toBe("function");
    // bulk mirrors the nesting, including deep paths
    expect(typeof api.bulk.plug.on).toBe("function");
    expect(typeof api.bulk.motion.pir.sensitivity.set).toBe("function");
  });
});

describe("OpResult contract", () => {
  it("a successful command resolves to ok:true with the device value", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const r = await api.plug.on({ host: "127.0.0.1", port: server.port });
      expect(r.ok).toBe(true);
      expect(r.op).toBe("plug.on");
      expect(r.host).toBe("127.0.0.1");
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
    const r = await api.dimmer.brightness.set({ host: "127.0.0.1", port: 9999 }, 0);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1\.\.100/);
  });
});

describe("device resources", () => {
  it("info.get returns full sysinfo as value", async () => {
    const sysinfo = { alias: "Living Room", model: "HS110(US)", relay_state: 1, led_off: 0 };
    const server = await startFakeTcp(() => ({ system: { get_sysinfo: sysinfo } }));
    try {
      const r = await api.device.info.get({ host: "127.0.0.1", port: server.port });
      expect(r.value).toEqual(sysinfo);
    } finally {
      await server.close();
    }
  });

  it("alias.get derives the alias from sysinfo", async () => {
    const server = await startFakeTcp(() => ({ system: { get_sysinfo: { alias: "Hallway" } } }));
    try {
      const r = await api.device.alias.get({ host: "127.0.0.1", port: server.port });
      expect(r.ok).toBe(true);
      expect(r.value).toBe("Hallway");
    } finally {
      await server.close();
    }
  });

  it("alias.set sends system.set_dev_alias", async () => {
    const server = await startFakeTcp(() => ({ system: { set_dev_alias: { err_code: 0 } } }));
    try {
      const r = await api.device.alias.set({ host: "127.0.0.1", port: server.port }, "New Name");
      expect(r.ok).toBe(true);
      expect(server.received[0]).toEqual({ system: { set_dev_alias: { alias: "New Name" } } });
    } finally {
      await server.close();
    }
  });

  it("led.get derives LED-on from sysinfo led_off", async () => {
    const server = await startFakeTcp(() => ({ system: { get_sysinfo: { led_off: 1 } } }));
    try {
      const r = await api.device.led.get({ host: "127.0.0.1", port: server.port });
      expect(r.value).toBe(false); // led_off:1 => LED is off
    } finally {
      await server.close();
    }
  });

  it("led.set(on=true) sends led_off:0 (the device stores the inverse)", async () => {
    const server = await startFakeTcp(() => ({ system: { set_led_off: { err_code: 0 } } }));
    try {
      await api.device.led.set({ host: "127.0.0.1", port: server.port }, true);
      expect(server.received[0]).toEqual({ system: { set_led_off: { off: 0 } } });
    } finally {
      await server.close();
    }
  });
});

describe("plug resources", () => {
  it("on() sends set_relay_state:1", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      await api.plug.on({ host: "127.0.0.1", port: server.port });
      expect(server.received[0]).toEqual({ system: { set_relay_state: { state: 1 } } });
    } finally {
      await server.close();
    }
  });

  it("power.set(false) routes to off — set_relay_state:0", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const r = await api.plug.power.set({ host: "127.0.0.1", port: server.port }, false);
      expect(r.op).toBe("plug.off"); // router → the real op is plug.off
      expect(server.received[0]).toEqual({ system: { set_relay_state: { state: 0 } } });
    } finally {
      await server.close();
    }
  });

  it("power.get reads relay_state", async () => {
    const server = await startFakeTcp(() => ({ system: { get_sysinfo: { relay_state: 1 } } }));
    try {
      const r = await api.plug.power.get({ host: "127.0.0.1", port: server.port });
      expect(r.value).toBe(1);
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
      expect(r.value).toBe(1);
      expect(relayState).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("children.set includes a child_ids context", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      await api.plug.children.set(
        { host: "127.0.0.1", port: server.port },
        ["80060000abcd0001"],
        true
      );
      expect(server.received[0]).toEqual({
        system: { set_relay_state: { state: 1 } },
        context: { child_ids: ["80060000abcd0001"] }
      });
    } finally {
      await server.close();
    }
  });

  it("children.set with an empty id list resolves to ok:false", async () => {
    const r = await api.plug.children.set({ host: "127.0.0.1", port: 9999 }, [], true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least one/);
  });
});

describe("dimmer resources", () => {
  const NS = "smartlife.iot.dimmer";

  it("brightness.set sends set_brightness", async () => {
    const server = await startFakeTcp(() => ({ [NS]: { set_brightness: { err_code: 0 } } }));
    try {
      await api.dimmer.brightness.set({ host: "127.0.0.1", port: server.port }, 60);
      expect(server.received[0]).toEqual({ [NS]: { set_brightness: { brightness: 60 } } });
    } finally {
      await server.close();
    }
  });

  it("brightness.set with a duration sends set_dimmer_transition", async () => {
    const server = await startFakeTcp(() => ({ [NS]: { set_dimmer_transition: { err_code: 0 } } }));
    try {
      await api.dimmer.brightness.set({ host: "127.0.0.1", port: server.port }, 40, 1500);
      expect(server.received[0]).toEqual({
        [NS]: { set_dimmer_transition: { brightness: 40, mode: "gentle_on_off", duration: 1500 } }
      });
    } finally {
      await server.close();
    }
  });

  it("parameters.get returns the tuning block", async () => {
    const params = { minThreshold: 12, fadeOnTime: 800, err_code: 0 };
    const server = await startFakeTcp(() => ({ [NS]: { get_dimmer_parameters: params } }));
    try {
      const r = await api.dimmer.parameters.get({ host: "127.0.0.1", port: server.port });
      expect(r.value).toMatchObject({ minThreshold: 12, fadeOnTime: 800 });
    } finally {
      await server.close();
    }
  });

  it("fade.on.get derives one field from get_dimmer_parameters", async () => {
    const server = await startFakeTcp(() => ({
      [NS]: { get_dimmer_parameters: { fadeOnTime: 800, fadeOffTime: 1200, err_code: 0 } }
    }));
    try {
      const r = await api.dimmer.fade.on.get({ host: "127.0.0.1", port: server.port });
      expect(r.op).toBe("dimmer.fade.on.get"); // event under the child path
      expect(r.value).toBe(800);
      expect(server.received[0]).toEqual({ [NS]: { get_dimmer_parameters: {} } });
    } finally {
      await server.close();
    }
  });

  it("fade.on.set sends set_fade_on_time", async () => {
    const server = await startFakeTcp(() => ({ [NS]: { set_fade_on_time: { err_code: 0 } } }));
    try {
      await api.dimmer.fade.on.set({ host: "127.0.0.1", port: server.port }, 750);
      expect(server.received[0]).toEqual({ [NS]: { set_fade_on_time: { fadeTime: 750 } } });
    } finally {
      await server.close();
    }
  });

  it("doubleClick.set includes the preset brightness as `index`", async () => {
    const server = await startFakeTcp(() => ({ [NS]: { set_double_click_action: { err_code: 0 } } }));
    try {
      await api.dimmer.doubleClick.set({ host: "127.0.0.1", port: server.port }, "preset", 75);
      expect(server.received[0]).toEqual({ [NS]: { set_double_click_action: { mode: "preset", index: 75 } } });
    } finally {
      await server.close();
    }
  });
});

describe("bulb resources", () => {
  const NS = "smartlife.iot.smartbulb.lightingservice";

  it("brightness.set sends the transition payload", async () => {
    const server = await startFakeTcp(() => ({
      [NS]: { transition_light_state: { err_code: 0, brightness: 50 } }
    }));
    try {
      await api.bulb.brightness.set({ host: "127.0.0.1", port: server.port }, 50, 500);
      expect(server.received[0][NS]?.transition_light_state).toMatchObject({
        on_off: 1,
        brightness: 50,
        transition_period: 500
      });
    } finally {
      await server.close();
    }
  });

  it("color.set zeroes color_temp so the bulb leaves white-temp mode", async () => {
    const server = await startFakeTcp(() => ({ [NS]: { transition_light_state: { err_code: 0 } } }));
    try {
      await api.bulb.color.set(
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

  it("color.get derives hue/saturation/value from light state", async () => {
    const server = await startFakeTcp(() => ({
      [NS]: { get_light_state: { on_off: 1, hue: 120, saturation: 50, brightness: 90 } }
    }));
    try {
      const r = await api.bulb.color.get({ host: "127.0.0.1", port: server.port });
      expect(r.value).toEqual({ hue: 120, saturation: 50, value: 90 });
    } finally {
      await server.close();
    }
  });

  it("out-of-range brightness resolves to ok:false", async () => {
    const r = await api.bulb.brightness.set({ host: "127.0.0.1", port: 9999 }, 200);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1\.\.100/);
  });
});

describe("motion resources", () => {
  const PIR = "smartlife.iot.PIR";
  const LAS = "smartlife.iot.LAS";

  it("pir.get reads the PIR config", async () => {
    const cfg = { enable: 1, trigger_index: 1, cold_time: 60000, err_code: 0 };
    const server = await startFakeTcp(() => ({ [PIR]: { get_config: cfg } }));
    try {
      const r = await api.motion.pir.get({ host: "127.0.0.1", port: server.port });
      expect(r.value).toMatchObject({ enable: 1, trigger_index: 1 });
    } finally {
      await server.close();
    }
  });

  it("pir.set toggles PIR.set_enable", async () => {
    const server = await startFakeTcp(() => ({ [PIR]: { set_enable: { err_code: 0 } } }));
    try {
      await api.motion.pir.set({ host: "127.0.0.1", port: server.port }, false);
      expect(server.received[0]).toEqual({ [PIR]: { set_enable: { enable: 0 } } });
    } finally {
      await server.close();
    }
  });

  it("pir.sensitivity.get derives trigger_index from pir.get", async () => {
    const server = await startFakeTcp(() => ({ [PIR]: { get_config: { trigger_index: 2, err_code: 0 } } }));
    try {
      const r = await api.motion.pir.sensitivity.get({ host: "127.0.0.1", port: server.port });
      expect(r.op).toBe("motion.pir.sensitivity.get");
      expect(r.value).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("pir.sensitivity.set sends PIR.set_trigger_index", async () => {
    const server = await startFakeTcp(() => ({ [PIR]: { set_trigger_index: { err_code: 0 } } }));
    try {
      await api.motion.pir.sensitivity.set({ host: "127.0.0.1", port: server.port }, 2);
      expect(server.received[0]).toEqual({ [PIR]: { set_trigger_index: { index: 2 } } });
    } finally {
      await server.close();
    }
  });

  // python-kasa's calibration-free PIR model — see src/api/motion/motion.mts.
  const pirCfg = { enable: 1, min_adc: 0, max_adc: 4095, trigger_index: 1, array: [80, 50, 20, 0], err_code: 0 };

  it("pir.status.get merges get_config + get_adc_value into a motion state", async () => {
    const server = await startFakeTcp((cmd) => {
      // The status read asks for both methods in one round-trip.
      expect(cmd[PIR]).toHaveProperty("get_config");
      expect(cmd[PIR]).toHaveProperty("get_adc_value");
      return { [PIR]: { get_config: pirCfg, get_adc_value: { value: 2041, err_code: 0 } } };
    });
    try {
      const r = await api.motion.pir.status.get({ host: "127.0.0.1", port: server.port });
      expect(r.ok).toBe(true);
      expect(r.value.adcValue).toBe(2041);
      // ADC near the 2047 midpoint → at rest, no motion.
      expect(r.value.triggered).toBe(false);
      expect(Math.abs(r.value.percent)).toBeLessThan(50);
    } finally {
      await server.close();
    }
  });

  it("pir.status.get reports triggered when the ADC rails away from midpoint", async () => {
    const server = await startFakeTcp(() => ({
      [PIR]: { get_config: pirCfg, get_adc_value: { value: 0, err_code: 0 } }
    }));
    try {
      const r = await api.motion.pir.status.get({ host: "127.0.0.1", port: server.port });
      expect(r.value.triggered).toBe(true);
      expect(Math.abs(r.value.percent)).toBeGreaterThan(50);
    } finally {
      await server.close();
    }
  });

  it("pir.triggered.get derives the boolean and is false when the PIR is disabled", async () => {
    const server = await startFakeTcp(() => ({
      // Railed ADC, but enable:0 — a disabled sensor never reports motion.
      [PIR]: { get_config: { ...pirCfg, enable: 0 }, get_adc_value: { value: 4000, err_code: 0 } }
    }));
    try {
      const r = await api.motion.pir.triggered.get({ host: "127.0.0.1", port: server.port });
      expect(r.op).toBe("motion.pir.triggered.get");
      expect(r.value).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("ambient.enabled.set targets the LAS namespace", async () => {
    const server = await startFakeTcp(() => ({ [LAS]: { set_enable: { err_code: 0 } } }));
    try {
      await api.motion.ambient.enabled.set({ host: "127.0.0.1", port: server.port }, true);
      expect(server.received[0]).toEqual({ [LAS]: { set_enable: { enable: 1 } } });
    } finally {
      await server.close();
    }
  });

  it("a negative sensitivity index resolves to ok:false", async () => {
    const r = await api.motion.pir.sensitivity.set({ host: "127.0.0.1", port: 9999 }, -1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-negative/);
  });
});

describe("energy resources", () => {
  it("realtime.get returns the emeter snapshot", async () => {
    const snap = { voltage_mv: 121000, current_ma: 250, power_mw: 31000, total_wh: 1234 };
    const server = await startFakeTcp(() => ({ emeter: { get_realtime: { ...snap, err_code: 0 } } }));
    try {
      const r = await api.energy.realtime.get({ host: "127.0.0.1", port: server.port });
      expect(r.value).toMatchObject(snap);
    } finally {
      await server.close();
    }
  });

  it("stats.daily.get returns the day_list array", async () => {
    const days = [{ year: 2026, month: 5, day: 1, energy_wh: 412 }];
    const server = await startFakeTcp(() => ({ emeter: { get_daystat: { day_list: days, err_code: 0 } } }));
    try {
      const r = await api.energy.stats.daily.get({ host: "127.0.0.1", port: server.port }, 2026, 5);
      expect(r.value).toEqual(days);
    } finally {
      await server.close();
    }
  });

  it("stats.daily.get with an invalid month resolves to ok:false", async () => {
    const r = await api.energy.stats.daily.get({ host: "127.0.0.1", port: 9999 }, 2026, 13);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1\.\.12/);
  });
});

describe("switch resources", () => {
  it("on() sends set_relay_state:1", async () => {
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
    } finally {
      await server.close();
    }
  });
});

describe("schedule resources", () => {
  it("rules.clear sends schedule.delete_all_rules", async () => {
    const server = await startFakeTcp(() => ({ schedule: { delete_all_rules: { err_code: 0 } } }));
    try {
      const r = await api.schedule.rules.clear({ host: "127.0.0.1", port: server.port });
      expect(r.ok).toBe(true);
      expect(server.received[0]).toEqual({ schedule: { delete_all_rules: {} } });
    } finally {
      await server.close();
    }
  });
});

describe("api.events", () => {
  it("emits op / <path> / success with a target-carrying payload", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      const pathSeen = nextOp("plug.on");
      const successSeen = nextOp("success", (e) => e.op === "plug.on");
      await api.plug.on({ host: "127.0.0.1", port: server.port });
      const ev = await pathSeen;
      expect(ev.module).toBe("plug");
      expect(ev.ok).toBe(true);
      expect(ev.target).toEqual({ host: "127.0.0.1", port: server.port });
      await successSeen;
    } finally {
      await server.close();
    }
  });

  it("event paths follow the nested endpoint depth", async () => {
    const PIR = "smartlife.iot.PIR";
    const server = await startFakeTcp(() => ({ [PIR]: { set_trigger_index: { err_code: 0 } } }));
    try {
      const seen = nextOp("motion.pir.sensitivity.set");
      await api.motion.pir.sensitivity.set({ host: "127.0.0.1", port: server.port }, 1);
      const ev = await seen;
      expect(ev.op).toBe("motion.pir.sensitivity.set");
      expect(ev.module).toBe("motion");
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
    } finally {
      await live.close();
    }
  });

  it("mirrors deeply nested resources (bulk.motion.pir.sensitivity.set)", async () => {
    const PIR = "smartlife.iot.PIR";
    const server = await startFakeTcp(() => ({ [PIR]: { set_trigger_index: { err_code: 0 } } }));
    try {
      const results = await api.bulk.motion.pir.sensitivity.set([{ host: "127.0.0.1", port: server.port }], 1);
      expect(results[0].ok).toBe(true);
      expect(server.received[0]).toEqual({ [PIR]: { set_trigger_index: { index: 1 } } });
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
          { host: "127.0.0.1", port: 1 }
        ],
        timeoutMs: 400
      });
      expect(report).toHaveLength(3);
      expect(report[0]).toMatchObject({ alias: "Close", rssi: -45, quality: "excellent" });
      expect(report[1]).toMatchObject({ alias: "Far", rssi: -78, quality: "weak" });
      expect(report[2]).toMatchObject({ rssi: null, reachable: false });
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
      expect(devices[0].sysInfo).toMatchObject({ alias: "Discovery Plug" });
    } finally {
      await server.close();
    }
  });

  it("returns an empty list when no devices respond", async () => {
    const devices = await api.discovery.discover({ broadcast: "127.0.0.1", port: 1, timeoutMs: 200 });
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
      expect(devices.map((d) => d.host)).toEqual(["127.0.0.2", "127.0.0.3"]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("refuses to sweep an unreasonably large range", async () => {
    await expect(api.discovery.sweep("10.0.0.0/8")).rejects.toThrow(/refusing to sweep/);
  });

  it("rejects a malformed CIDR", async () => {
    await expect(api.discovery.sweep("10.8.1.0")).rejects.toThrow(/Invalid CIDR/);
  });
});

describe("api.devices — resolver + cache", () => {
  it("resolve() returns an IP target directly, with no sweep", async () => {
    expect(await api.devices.resolve("10.9.9.9")).toEqual({ host: "10.9.9.9" });
  });

  it("resolve() passes a DeviceTarget through unchanged", async () => {
    const ref = { host: "10.9.9.9", port: 1234, timeoutMs: 500 };
    expect(await api.devices.resolve(ref)).toBe(ref);
  });

  it("resolves a device by alias (case-insensitive) and by MAC from the cache", async () => {
    const a = await startFakeTcp(
      () => ({ system: { get_sysinfo: { alias: "Hall Lamp", model: "HS200(US)", mac: "AA:BB:CC:00:00:01" } } }),
      { host: "127.0.0.2" }
    );
    const b = await startFakeTcp(
      () => ({ system: { get_sysinfo: { alias: "Desk Plug", model: "HS105(US)", mac: "AA:BB:CC:00:00:02" } } }),
      { host: "127.0.0.3", port: a.port }
    );
    try {
      await api.devices.refresh({ cidr: "127.0.0.2/31", port: a.port, timeoutMs: 500 });
      expect((await api.devices.resolve("Hall Lamp")).host).toBe("127.0.0.2");
      expect((await api.devices.resolve("hall lamp")).host).toBe("127.0.0.2");
      expect((await api.devices.resolve("aabbcc000002")).host).toBe("127.0.0.3");
      expect((await api.devices.resolve("AA:BB:CC:00:00:02")).host).toBe("127.0.0.3");
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("resolve() rejects a name that isn't in the cache", async () => {
    const a = await startFakeTcp(
      () => ({ system: { get_sysinfo: { alias: "Known", mac: "AA:BB:CC:00:00:09" } } }),
      { host: "127.0.0.2" }
    );
    try {
      await api.devices.refresh({ cidr: "127.0.0.2/32", port: a.port, timeoutMs: 500 });
      await expect(api.devices.resolve("Nonexistent")).rejects.toThrow(/No Kasa device matching/);
    } finally {
      await a.close();
    }
  });

  it("list() serves the cache without re-sweeping", async () => {
    const a = await startFakeTcp(
      () => ({ system: { get_sysinfo: { alias: "Cached", mac: "AA:BB:CC:00:00:0A" } } }),
      { host: "127.0.0.2" }
    );
    // Prime the cache, then drop the server — a re-sweep would now find nothing.
    const first = await api.devices.refresh({ cidr: "127.0.0.2/32", port: a.port, timeoutMs: 500 });
    expect(first).toHaveLength(1);
    await a.close();
    const second = await api.devices.list();
    expect(second).toHaveLength(1);
    expect(second[0].sysInfo.alias).toBe("Cached");
  });
});

describe("api.monitor", () => {
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
      relayState = 1;
      activeMode = "count_down";
      const onEv = await nextEvent(w, "on");
      expect(onEv.changedTo).toBe(1);
      // Relay-only watch can't attribute the cause — only a motion watch can.
      expect(onEv.triggeredBy).toBe("unknown");
      expect(onEv.activeMode).toBe("count_down");
      relayState = 0;
      activeMode = "none";
      const offEv = await nextEvent(w, "off");
      expect(offEv.changedTo).toBe(0);
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

  it("watchMotion debounces a PIR burst into one motion event, then clear", async () => {
    const PIR = "smartlife.iot.PIR";
    const pirCfg = { enable: 1, min_adc: 0, max_adc: 4095, trigger_index: 1, array: [80, 50, 20, 0], err_code: 0 };
    let adc = 2040; // idle: near the 2047 midpoint
    const server = await startFakeTcp((cmd) => {
      if (cmd[PIR]) return { [PIR]: { get_config: pirCfg, get_adc_value: { value: adc, err_code: 0 } } };
      return { err: 1 };
    });
    const w = api.monitor.watchMotion(
      { host: "127.0.0.1", port: server.port },
      { intervalMs: 250, clearMs: 300 }
    );
    try {
      adc = 0; // railed → motion
      const motionEv = await nextEvent(w, "motion");
      expect(motionEv.detected).toBe(true);
      expect(Math.abs(motionEv.percent)).toBeGreaterThan(50);
      adc = 2040; // back to idle → after clearMs of quiet, clears
      const clearEv = await nextEvent(w, "clear");
      expect(clearEv.detected).toBe(false);
      expect(clearEv.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      w.stop();
      await server.close();
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
