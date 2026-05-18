/**
 * Kasa local-network protocol (port 9999).
 *
 * Devices accept JSON commands encrypted with an autokey XOR stream
 * starting from seed 0xAB. TCP frames are length-prefixed (4-byte BE);
 * UDP datagrams are not.
 *
 * Self-contained on purpose: the cipher is inlined rather than imported
 * from a sibling module. Slothlet transpiles each `.mts` to its own cache
 * file, so relative imports between API modules don't resolve — and the
 * cipher returns `Buffer`s, which slothlet's wrapper proxies (breaking
 * `TypedArray.length`) if passed across the `self` boundary.
 */
import { createConnection } from "node:net";
import { createSocket } from "node:dgram";
import type {
  DeviceTarget,
  KasaCommand,
  KasaResponse
} from "../../lib/types.mts";

const DEFAULT_PORT = 9999;
const DEFAULT_TIMEOUT_MS = 5000;
const XOR_SEED = 0xab;
const MAX_FRAME_BYTES = 1 << 20;

/** TCP encryption — autokey-XOR body prefixed with a 4-byte big-endian length. */
export function encryptTcp(data: string): Buffer {
  const payload = Buffer.from(data, "utf8");
  const body = Buffer.alloc(payload.length);
  let key = XOR_SEED;
  for (let i = 0; i < payload.length; i++) {
    const c = key ^ (payload[i] as number);
    body[i] = c;
    key = c;
  }
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/** TCP decryption — accepts the full length-prefixed frame. */
export function decryptTcp(frame: Buffer): string {
  if (frame.length < 4) throw new Error("Kasa TCP frame too short");
  const declared = frame.readUInt32BE(0);
  const body = frame.subarray(4, 4 + declared);
  if (body.length !== declared) {
    throw new Error(`Kasa TCP frame truncated: expected ${declared} bytes, got ${body.length}`);
  }
  const out = Buffer.alloc(body.length);
  let key = XOR_SEED;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as number;
    out[i] = key ^ c;
    key = c;
  }
  return out.toString("utf8");
}

/** UDP encryption — same autokey cipher, no length prefix. */
export function encryptUdp(data: string): Buffer {
  const payload = Buffer.from(data, "utf8");
  const out = Buffer.alloc(payload.length);
  let key = XOR_SEED;
  for (let i = 0; i < payload.length; i++) {
    const c = key ^ (payload[i] as number);
    out[i] = c;
    key = c;
  }
  return out;
}

/** UDP decryption — inverse of {@link encryptUdp}. */
export function decryptUdp(payload: Buffer): string {
  const out = Buffer.alloc(payload.length);
  let key = XOR_SEED;
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i] as number;
    out[i] = key ^ c;
    key = c;
  }
  return out.toString("utf8");
}

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
  const frame = encryptTcp(JSON.stringify(command));

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
          settle(null, parseJson(decryptTcp(full)));
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
  const payload = encryptUdp(JSON.stringify(command));

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
        settle(null, parseJson(decryptUdp(msg)));
      } catch (err) {
        settle(err as Error);
      }
    });

    socket.send(payload, 0, payload.length, port, host, (err) => {
      if (err) settle(err);
    });
  });
}
