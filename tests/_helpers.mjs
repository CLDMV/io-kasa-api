/**
 * Test helpers: lightweight fake Kasa TCP/UDP servers that speak the real
 * port-9999 protocol so we can exercise the protocol/discovery/device modules
 * end-to-end without hardware.
 */
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { Buffer } from "node:buffer";

const XOR_SEED = 0xab;

/** @param {string} data */
export function encryptTcp(data) {
  const payload = Buffer.from(data, "utf8");
  const body = Buffer.alloc(payload.length);
  let key = XOR_SEED;
  for (let i = 0; i < payload.length; i++) {
    const c = key ^ payload[i];
    body[i] = c;
    key = c;
  }
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/** @param {Buffer} frame */
export function decryptTcp(frame) {
  const len = frame.readUInt32BE(0);
  const body = frame.subarray(4, 4 + len);
  const out = Buffer.alloc(body.length);
  let key = XOR_SEED;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    out[i] = key ^ c;
    key = c;
  }
  return out.toString("utf8");
}

/** @param {string} data */
export function encryptUdp(data) {
  const payload = Buffer.from(data, "utf8");
  const out = Buffer.alloc(payload.length);
  let key = XOR_SEED;
  for (let i = 0; i < payload.length; i++) {
    const c = key ^ payload[i];
    out[i] = c;
    key = c;
  }
  return out;
}

/** @param {Buffer} payload */
export function decryptUdp(payload) {
  const out = Buffer.alloc(payload.length);
  let key = XOR_SEED;
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    out[i] = key ^ c;
    key = c;
  }
  return out.toString("utf8");
}

/**
 * Start a fake Kasa TCP server on 127.0.0.1.
 * `handler(request)` receives the parsed JSON command and returns the response object (or a Promise).
 *
 * @param {(cmd: Record<string, Record<string, unknown>>) => unknown} handler
 * @returns {Promise<{ port: number; close: () => Promise<void>; received: Array<Record<string, unknown>> }>}
 */
export async function startFakeTcp(handler) {
  /** @type {Array<Record<string, unknown>>} */
  const received = [];
  const server = createServer((socket) => {
    /** @type {Buffer} */
    let buf = Buffer.alloc(0);
    let expected = null;
    socket.on("data", async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (expected === null && buf.length >= 4) {
        expected = buf.readUInt32BE(0);
      }
      if (expected !== null && buf.length >= 4 + expected) {
        const command = JSON.parse(decryptTcp(buf));
        received.push(command);
        const response = await handler(command);
        socket.write(encryptTcp(JSON.stringify(response)));
        socket.end();
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to bind fake TCP server");
  return {
    port: addr.port,
    received,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
      })
  };
}

/**
 * Start a fake Kasa UDP responder on 127.0.0.1.
 * `handler(request)` receives the parsed JSON and returns the response (or null to ignore).
 *
 * @param {(cmd: Record<string, Record<string, unknown>>) => unknown | null} handler
 * @returns {Promise<{ port: number; close: () => Promise<void> }>}
 */
export async function startFakeUdp(handler) {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", async (msg, rinfo) => {
    let request;
    try {
      request = JSON.parse(decryptUdp(msg));
    } catch {
      return;
    }
    const response = await handler(request);
    if (response == null) return;
    const payload = encryptUdp(JSON.stringify(response));
    socket.send(payload, 0, payload.length, rinfo.port, rinfo.address);
  });
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => resolve(undefined));
  });
  const addr = socket.address();
  return {
    port: addr.port,
    close: () =>
      new Promise((resolve) => {
        socket.close(() => resolve(undefined));
      })
  };
}
