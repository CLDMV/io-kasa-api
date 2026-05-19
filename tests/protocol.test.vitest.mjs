import { describe, it, expect } from "vitest";
import {
  encryptTcp,
  decryptTcp,
  encryptUdp,
  decryptUdp,
  send,
  sendUdp
} from "../src/api/protocol/protocol.mts";
import {
  startFakeTcp,
  startFakeUdp,
  encryptTcp as helperEncryptTcp,
  decryptTcp as helperDecryptTcp,
  encryptUdp as helperEncryptUdp
} from "./_helpers.mjs";

describe("protocol — XOR cipher", () => {
  it("UDP round-trips arbitrary JSON", () => {
    const payload = JSON.stringify({ system: { get_sysinfo: {} } });
    const encrypted = encryptUdp(payload);
    expect(Buffer.isBuffer(encrypted)).toBe(true);
    expect(encrypted.toString()).not.toBe(payload);
    expect(decryptUdp(encrypted)).toBe(payload);
  });

  it("TCP frames are length-prefixed and round-trip", () => {
    const payload = JSON.stringify({ system: { set_relay_state: { state: 1 } } });
    const frame = encryptTcp(payload);
    expect(frame.readUInt32BE(0)).toBe(Buffer.byteLength(payload, "utf8"));
    expect(frame.length).toBe(4 + Buffer.byteLength(payload, "utf8"));
    expect(decryptTcp(frame)).toBe(payload);
  });

  it("matches the reference autokey-XOR vector starting from 0xAB", () => {
    // Reference: encrypt of "{}" — first byte 0x7b ('{') XOR 0xab = 0xd0.
    // Second byte 0x7d ('}') XOR 0xd0 (previous ciphertext) = 0xad.
    const encrypted = encryptUdp("{}");
    expect(encrypted[0]).toBe(0xd0);
    expect(encrypted[1]).toBe(0xad);
  });

  it("UDP decryption matches the helper's independent implementation", () => {
    const payload = JSON.stringify({ hello: "world", n: 1, list: [1, 2, 3] });
    const a = encryptUdp(payload);
    const b = helperEncryptUdp(payload);
    expect(a.equals(b)).toBe(true);
  });

  it("decryptTcp returns a Failure sentinel for truncated frames (no throw)", () => {
    const frame = encryptTcp("hello");
    const truncated = frame.subarray(0, frame.length - 2);
    const result = decryptTcp(truncated);
    expect(result && typeof result === "object" && "__failure" in result).toBe(true);
    expect(result.__failure).toMatch(/truncated/);
  });
});

describe("protocol — TCP transport", () => {
  it("send() encrypts request, decrypts response, returns parsed JSON", async () => {
    const sysinfo = { alias: "Bedroom Lamp", relay_state: 0, model: "HS100(US)" };
    const server = await startFakeTcp(() => ({ system: { get_sysinfo: sysinfo } }));
    try {
      const result = await send(
        { host: "127.0.0.1", port: server.port, timeoutMs: 1000 },
        { system: { get_sysinfo: {} } }
      );
      expect(result).toEqual({ system: { get_sysinfo: sysinfo } });
      expect(server.received).toHaveLength(1);
      expect(server.received[0]).toEqual({ system: { get_sysinfo: {} } });
    } finally {
      await server.close();
    }
  });

  it("send() rejects on connection-refused", async () => {
    // 127.0.0.1:1 is reserved/unused — connect should ECONNREFUSED quickly.
    await expect(
      send({ host: "127.0.0.1", port: 1, timeoutMs: 500 }, { system: { get_sysinfo: {} } })
    ).rejects.toThrow();
  });

  it("send() times out when the server never responds", async () => {
    const server = await startFakeTcp(() => new Promise(() => {})); // hang forever
    try {
      await expect(
        send(
          { host: "127.0.0.1", port: server.port, timeoutMs: 150 },
          { system: { get_sysinfo: {} } }
        )
      ).rejects.toThrow(/timeout/i);
    } finally {
      await server.close();
    }
  });

  it("client request frames decode to the same JSON the server received", async () => {
    const server = await startFakeTcp(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    try {
      await send(
        { host: "127.0.0.1", port: server.port, timeoutMs: 1000 },
        { system: { set_relay_state: { state: 1 } } }
      );
      // round-trip the helper's own ciphertext through the production decrypter
      const frame = helperEncryptTcp(JSON.stringify(server.received[0]));
      expect(decryptTcp(frame)).toBe(JSON.stringify(server.received[0]));
      expect(helperDecryptTcp(frame)).toBe(JSON.stringify(server.received[0]));
    } finally {
      await server.close();
    }
  });
});

describe("protocol — UDP transport", () => {
  it("sendUdp() encrypts, sends, and parses the first matching reply", async () => {
    const server = await startFakeUdp(() => ({
      system: { get_sysinfo: { alias: "udp-plug", relay_state: 1 } }
    }));
    try {
      const result = await sendUdp(
        { host: "127.0.0.1", port: server.port, timeoutMs: 1000 },
        { system: { get_sysinfo: {} } }
      );
      expect(result.system.get_sysinfo).toMatchObject({ alias: "udp-plug" });
    } finally {
      await server.close();
    }
  });

  it("sendUdp() times out when no reply arrives", async () => {
    const server = await startFakeUdp(() => null);
    try {
      await expect(
        sendUdp(
          { host: "127.0.0.1", port: server.port, timeoutMs: 200 },
          { system: { get_sysinfo: {} } }
        )
      ).rejects.toThrow(/timeout/i);
    } finally {
      await server.close();
    }
  });
});
