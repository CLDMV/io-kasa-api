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
