/**
 * Kasa local-network protocol (port 9999).
 *
 * Devices accept JSON commands encrypted with an autokey XOR stream
 * starting from seed 0xAB. TCP frames are length-prefixed (4-byte BE);
 * UDP datagrams are not.
 *
 * This module owns the cipher and exports it; other API modules reach it
 * via `self.protocol` rather than a relative import (slothlet transpiles
 * each `.mts` to its own flat cache file, so sibling imports don't
 * resolve). Slothlet 3.6.0+ no longer proxy-wraps `Buffer`s crossing the
 * `self` boundary, so the exported cipher is safe to use across modules.
 *
 * No `throw` keyword in this file. Decode/parse helpers return a
 * {@link Failure} sentinel on bad input; `send`/`sendUdp` translate that
 * into a Promise rejection (which run()'s try/catch catches).
 */
import { createConnection } from "node:net";
import { createSocket } from "node:dgram";
import type { DeviceTarget, Failure, KasaCommand, KasaResponse } from "../../lib/types.mts";

const DEFAULT_PORT = 9999;
const DEFAULT_TIMEOUT_MS = 5000;
const XOR_SEED = 0xab;
const MAX_FRAME_BYTES = 1 << 20;

/** Inline Failure check — `protocol` doesn't need to reach for `self.events`. */
function isFailure(v: unknown): v is Failure {
	return v !== null && typeof v === "object" && "__failure" in (v as Record<string, unknown>);
}

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

/** TCP decryption — accepts the full length-prefixed frame. Returns Failure on bad input. */
export function decryptTcp(frame: Buffer): string | Failure {
	if (frame.length < 4) return { __failure: "Kasa TCP frame too short" };
	const declared = frame.readUInt32BE(0);
	const body = frame.subarray(4, 4 + declared);
	if (body.length !== declared) {
		return { __failure: `Kasa TCP frame truncated: expected ${declared} bytes, got ${body.length}` };
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

function parseJson(raw: string): KasaResponse | Failure {
	try {
		return JSON.parse(raw) as KasaResponse;
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		return { __failure: `Kasa device returned invalid JSON: ${raw} (${cause})` };
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
				const decoded = decryptTcp(full);
				if (isFailure(decoded)) {
					settle(new Error(decoded.__failure));
					return;
				}
				const parsed = parseJson(decoded);
				if (isFailure(parsed)) {
					settle(new Error(parsed.__failure));
					return;
				}
				settle(null, parsed);
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
			const decoded = decryptUdp(msg);
			const parsed = parseJson(decoded);
			if (isFailure(parsed)) {
				settle(new Error(parsed.__failure));
				return;
			}
			settle(null, parsed);
		});

		socket.send(payload, 0, payload.length, port, host, (err) => {
			if (err) settle(err);
		});
	});
}
