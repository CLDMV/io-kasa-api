/**
 * Kasa autokey XOR cipher.
 *
 * Lives in `src/lib/` rather than `src/api/` so it is NOT exposed as a slothlet
 * endpoint — slothlet's class-instance wrapper would proxy returned Buffers
 * and break TypedArray `.length` access. Other API modules import this
 * directly via the on-disk build output.
 */

const XOR_SEED = 0xab;

/** TCP encryption — body is autokey-XOR, output is prefixed with a 4-byte big-endian length. */
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

/** UDP encryption — same autokey cipher with no length prefix. */
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
