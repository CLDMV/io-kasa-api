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
  // Best-effort: slothlet exposes a shutdown if present.
  try {
    await api?.slothlet?.shutdown?.();
  } catch {}
});

describe("slothlet API surface", () => {
  it("exposes every module namespace", () => {
    expect(typeof api.protocol).toBe("object");
    expect(typeof api.protocol.send).toBe("function");
    expect(typeof api.protocol.encryptUdp).toBe("function");
    expect(typeof api.discovery.discover).toBe("function");
    expect(typeof api.device.getSysInfo).toBe("function");
    expect(typeof api.plug.on).toBe("function");
    expect(typeof api.plug.off).toBe("function");
    expect(typeof api.plug.toggle).toBe("function");
    expect(typeof api.bulb.on).toBe("function");
    expect(typeof api.bulb.setBrightness).toBe("function");
    expect(typeof api.bulb.setColor).toBe("function");
    expect(typeof api.energy.getRealtime).toBe("function");
    expect(typeof api.schedule.getRules).toBe("function");
    expect(typeof api.switch.toggle).toBe("function");
    expect(typeof api.dimmer.setBrightness).toBe("function");
    expect(typeof api.motion.getPirConfig).toBe("function");
  });
});

describe("api.device", () => {
  it("getSysInfo returns the device's sysinfo block", async () => {
    const sysinfo = {
      alias: "Living Room",
      model: "HS110(US)",
      mac: "AA:BB:CC:DD:EE:FF",
      relay_state: 1
    };
    const server = await startFakeTcp(() => ({ system: { get_sysinfo: sysinfo } }));
    try {
      const info = await api.device.getSysInfo({ host: "127.0.0.1", port: server.port });
      expect(info).toEqual(sysinfo);
    } finally {
      await server.close();
    }
  });

  it("setAlias sends the expected system.set_dev_alias command", async () => {
    const server = await startFakeTcp(() => ({ system: { set_dev_alias: { err_code: 0 } } }));
    try {
      await api.device.setAlias({ host: "127.0.0.1", port: server.port }, "New Name");
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

  it("rejects when the device returns a non-zero err_code", async () => {
    const server = await startFakeTcp(() => ({
      system: { set_dev_alias: { err_code: -1, err_msg: "permission denied" } }
    }));
    try {
      await expect(
        api.device.setAlias({ host: "127.0.0.1", port: server.port }, "X")
      ).rejects.toThrow(/permission denied/);
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

  it("toggle() flips the reported state and returns the new value", async () => {
    let relayState = /** @type {0|1} */ (0);
    const server = await startFakeTcp((cmd) => {
      if (cmd.system?.get_sysinfo) {
        return { system: { get_sysinfo: { relay_state: relayState } } };
      }
      if (cmd.system?.set_relay_state) {
        relayState = /** @type {0|1} */ (cmd.system.set_relay_state.state);
        return { system: { set_relay_state: { err_code: 0 } } };
      }
      return { err: 1 };
    });
    try {
      const next = await api.plug.toggle({ host: "127.0.0.1", port: server.port });
      expect(next).toBe(1);
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

  it("setChildState rejects an empty id list", async () => {
    await expect(
      api.plug.setChildState({ host: "127.0.0.1", port: 9999 }, [], true)
    ).rejects.toThrow(/at least one/);
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
      const sent = server.received[0];
      expect(sent[NS]?.transition_light_state).toMatchObject({
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
    const server = await startFakeTcp(() => ({
      [NS]: { transition_light_state: { err_code: 0 } }
    }));
    try {
      await api.bulb.setColor(
        { host: "127.0.0.1", port: server.port },
        { hue: 200, saturation: 80, value: 70 }
      );
      const sent = server.received[0];
      expect(sent[NS]?.transition_light_state).toMatchObject({
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

  it("rejects out-of-range brightness", async () => {
    await expect(
      api.bulb.setBrightness({ host: "127.0.0.1", port: 9999 }, 200)
    ).rejects.toThrow(/1\.\.100/);
  });

  it("rejects out-of-range hue", async () => {
    await expect(
      api.bulb.setColor({ host: "127.0.0.1", port: 9999 }, { hue: 999, saturation: 50 })
    ).rejects.toThrow(/0\.\.360/);
  });
});

describe("api.energy", () => {
  it("getRealtime returns the emeter snapshot", async () => {
    const snap = { voltage_mv: 121000, current_ma: 250, power_mw: 31000, total_wh: 1234 };
    const server = await startFakeTcp(() => ({ emeter: { get_realtime: { ...snap, err_code: 0 } } }));
    try {
      const result = await api.energy.getRealtime({ host: "127.0.0.1", port: server.port });
      expect(result).toMatchObject(snap);
    } finally {
      await server.close();
    }
  });

  it("getDayStats returns the day_list array", async () => {
    const days = [
      { year: 2026, month: 5, day: 1, energy_wh: 412 },
      { year: 2026, month: 5, day: 2, energy_wh: 388 }
    ];
    const server = await startFakeTcp(() => ({
      emeter: { get_daystat: { day_list: days, err_code: 0 } }
    }));
    try {
      const result = await api.energy.getDayStats({ host: "127.0.0.1", port: server.port }, 2026, 5);
      expect(result).toEqual(days);
    } finally {
      await server.close();
    }
  });

  it("getDayStats rejects an invalid month", async () => {
    await expect(
      api.energy.getDayStats({ host: "127.0.0.1", port: 9999 }, 2026, 13)
    ).rejects.toThrow(/1\.\.12/);
  });
});

describe("api.discovery", () => {
  it("discovers a single device against a loopback UDP server", async () => {
    const sysinfo = {
      alias: "Discovery Plug",
      model: "HS105(US)",
      relay_state: 0
    };
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
      port: 1, // nothing listening
      timeoutMs: 200
    });
    expect(devices).toEqual([]);
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
      const next = await api.switch.toggle({ host: "127.0.0.1", port: server.port });
      expect(next).toBe(0);
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

  it("getParameters returns the dimmer tuning block", async () => {
    const params = { minThreshold: 12, fadeOnTime: 1000, fadeOffTime: 1000, err_code: 0 };
    const server = await startFakeTcp(() => ({ [NS]: { get_dimmer_parameters: params } }));
    try {
      const result = await api.dimmer.getParameters({ host: "127.0.0.1", port: server.port });
      expect(result).toMatchObject({ minThreshold: 12, fadeOnTime: 1000 });
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

  it("rejects out-of-range brightness", async () => {
    await expect(
      api.dimmer.setBrightness({ host: "127.0.0.1", port: 9999 }, 0)
    ).rejects.toThrow(/1\.\.100/);
  });
});

describe("api.motion", () => {
  const PIR = "smartlife.iot.PIR";
  const LAS = "smartlife.iot.LAS";

  it("getPirConfig reads the PIR sensor config", async () => {
    const cfg = { enable: 1, trigger_index: 1, cold_time: 60000, array: [80, 50, 20], err_code: 0 };
    const server = await startFakeTcp(() => ({ [PIR]: { get_config: cfg } }));
    try {
      const result = await api.motion.getPirConfig({ host: "127.0.0.1", port: server.port });
      expect(result).toMatchObject({ enable: 1, trigger_index: 1 });
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

  it("setPirSensitivity sends PIR.set_trigger_index", async () => {
    const server = await startFakeTcp(() => ({ [PIR]: { set_trigger_index: { err_code: 0 } } }));
    try {
      await api.motion.setPirSensitivity({ host: "127.0.0.1", port: server.port }, 2);
      expect(server.received[0]).toEqual({ [PIR]: { set_trigger_index: { index: 2 } } });
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

  it("rejects a negative sensitivity index", async () => {
    await expect(
      api.motion.setPirSensitivity({ host: "127.0.0.1", port: 9999 }, -1)
    ).rejects.toThrow(/non-negative/);
  });
});

describe("api.discovery — sweep (unicast CIDR scan)", () => {
  it("finds devices across a CIDR by unicast probe", async () => {
    // Loopback is 127.0.0.0/8 — host two fake "devices" on distinct IPs,
    // same port, and sweep the /31 that spans them.
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
      port: 1, // nothing listening
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
