/**
 * Kasa local-network protocol (port 9999).
 *
 * Devices accept JSON commands encrypted with an autokey XOR stream
 * starting from seed 0xAB. TCP frames are length-prefixed (4-byte BE);
 * UDP datagrams are not.
 *
 * This module is the only place that should touch sockets — every other
 * API module composes commands and calls `self.protocol.send(...)`.
 */
import { createConnection } from "node:net";
import { createSocket } from "node:dgram";
import {
  encryptTcp as cipherEncryptTcp,
  decryptTcp as cipherDecryptTcp,
  encryptUdp as cipherEncryptUdp,
  decryptUdp as cipherDecryptUdp
} from "../../lib/cipher.mjs";
import type {
  DeviceTarget,
  KasaCommand,
  KasaResponse
} from "../../lib/types.mts";

const DEFAULT_PORT = 9999;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_FRAME_BYTES = 1 << 20;

export const encryptTcp = cipherEncryptTcp;
export const decryptTcp = cipherDecryptTcp;
export const encryptUdp = cipherEncryptUdp;
export const decryptUdp = cipherDecryptUdp;

function parseJson(raw: string): KasaResponse {
  try {
    return JSON.parse(raw) as KasaResponse;
  } catch (err) {
    throw new Error(`Kasa device returned invalid JSON: ${raw}`, { cause: err as Error });
  }
}

/**
 * Send a command over TCP. Reassembles framed responses; the device closes
 * the connection after replying.
 */
export async function send(target: DeviceTarget, command: KasaCommand): Promise<KasaResponse> {
  const host = target.host;
  const port = target.port ?? DEFAULT_PORT;
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const frame = cipherEncryptTcp(JSON.stringify(command));

  return await new Promise<KasaResponse>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const chunks: Buffer[] = [];
    let expected: number | null = null;
    let received = 0;
    let settled = false;

    const settle = (err: Error | null, value?: KasaResponse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else if (value) resolve(value);
    };

    socket.setTimeout(timeoutMs, () => settle(new Error(`Kasa TCP timeout to ${host}:${port}`)));
    socket.once("error", (err) => settle(err));
    socket.once("connect", () => socket.write(frame));

    socket.on("data", (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (expected === null && received >= 4) {
        expected = Buffer.concat(chunks, received).readUInt32BE(0);
        if (expected > MAX_FRAME_BYTES) {
          settle(new Error(`Kasa response too large: ${expected} bytes`));
          return;
        }
      }
      if (expected !== null && received >= 4 + expected) {
        const full = Buffer.concat(chunks, received);
        try {
          settle(null, parseJson(cipherDecryptTcp(full)));
        } catch (err) {
          settle(err as Error);
        }
      }
    });

    socket.once("end", () => {
      if (settled) return;
      if (expected === null || received < 4 + expected) {
        settle(new Error("Kasa connection closed before full response received"));
      }
    });
  });
}

/**
 * Send a command over UDP. Used for devices that do not accept TCP on 9999
 * (or for unicast probes). The first matching reply is returned.
 */
export async function sendUdp(target: DeviceTarget, command: KasaCommand): Promise<KasaResponse> {
  const host = target.host;
  const port = target.port ?? DEFAULT_PORT;
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = cipherEncryptUdp(JSON.stringify(command));

  return await new Promise<KasaResponse>((resolve, reject) => {
    const socket = createSocket("udp4");
    let settled = false;
    const settle = (err: Error | null, value?: KasaResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else if (value) resolve(value);
    };

    const timer = setTimeout(() => settle(new Error(`Kasa UDP timeout to ${host}:${port}`)), timeoutMs);
    socket.once("error", (err) => settle(err));
    socket.on("message", (msg, rinfo) => {
      if (rinfo.address !== host) return;
      try {
        settle(null, parseJson(cipherDecryptUdp(msg)));
      } catch (err) {
        settle(err as Error);
      }
    });

    socket.send(payload, 0, payload.length, port, host, (err) => {
      if (err) settle(err);
    });
  });
}
