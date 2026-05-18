import { describe, it, expect } from "vitest";
import { resolveBroadcast } from "../src/lib/network.mts";

/** @typedef {import("node:os").NetworkInterfaceInfo} NIInfo */

/** @param {Record<string, NIInfo[]>} ifaces */
const fakeOs = (ifaces) => () => ifaces;

describe("resolveBroadcast", () => {
  const standard = fakeOs({
    lo: [
      { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }
    ],
    eth0: [
      { address: "192.168.1.42", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.1.42/24" }
    ],
    eth1: [
      { address: "10.0.5.7", netmask: "255.255.0.0", family: "IPv4", mac: "11:22:33:44:55:66", internal: false, cidr: "10.0.5.7/16" }
    ]
  });

  it("auto-picks the first non-loopback interface", () => {
    const r = resolveBroadcast(undefined, standard);
    expect(r.bindAddress).toBe("192.168.1.42");
    expect(r.broadcast).toBe("192.168.1.255");
    expect(r.interface).toBe("eth0");
    expect(r.cidr).toBe(24);
  });

  it("matches baseIp to the correct interface and computes the directed broadcast (/16)", () => {
    const r = resolveBroadcast("10.0.99.200", standard);
    expect(r.interface).toBe("eth1");
    expect(r.bindAddress).toBe("10.0.5.7");
    expect(r.broadcast).toBe("10.0.255.255");
    expect(r.cidr).toBe(16);
  });

  it("computes a /24 directed broadcast for the matching interface", () => {
    const r = resolveBroadcast("192.168.1.250", standard);
    expect(r.interface).toBe("eth0");
    expect(r.broadcast).toBe("192.168.1.255");
  });

  it("falls back to a /24 assumption when baseIp matches no interface", () => {
    const r = resolveBroadcast("172.16.99.10", standard);
    expect(r.bindAddress).toBe("172.16.99.10");
    expect(r.broadcast).toBe("172.16.99.255");
    expect(r.interface).toBe("unknown");
    expect(r.cidr).toBe(24);
  });

  it("skips loopback and link-local interfaces", () => {
    const onlyLinkLocal = fakeOs({
      lo: [
        { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }
      ],
      eth0: [
        { address: "169.254.10.20", netmask: "255.255.0.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "169.254.10.20/16" }
      ]
    });
    expect(() => resolveBroadcast(undefined, onlyLinkLocal)).toThrow(/No usable IPv4 interface/);
  });

  it("throws an informative error when only loopback is present", () => {
    const loopbackOnly = fakeOs({
      lo: [
        { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }
      ]
    });
    expect(() => resolveBroadcast(undefined, loopbackOnly)).toThrow(/No usable IPv4 interface/);
  });
});
