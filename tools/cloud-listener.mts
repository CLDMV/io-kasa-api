#!/usr/bin/env node
/**
 * Kasa cloud listener — a TLS server that impersonates the TP-Link cloud
 * endpoint so we can see whether a redirected device dials in, completes
 * the TLS handshake, and what (if anything) it pushes.
 *
 * TP-Link devices connect to their cloud on TCP 50443 (TLS). `set_server_url`
 * only changes the hostname, so this must listen on 50443.
 *
 * It logs every stage:
 *   - raw TCP connection      → the device reached us at all
 *   - TLS handshake OK/FAILED → whether it accepts our (self-signed) cert
 *   - decrypted bytes         → the proprietary cloud protocol, hex-dumped
 *
 * It never has to reply correctly — the goal is observation. A failed
 * handshake is still a useful result (it means the device validates certs).
 *
 * `--only=<ip>` engages just that device and instantly drops every other
 * client — so a network-wide DNS override only ever exercises the device
 * under test. `--only=any` engages everyone.
 *
 * Usage:
 *   node --experimental-strip-types tools/cloud-listener.mts \
 *     [--port=50443] [--cert=tmp/listener-cert.pem] [--key=tmp/listener-key.pem] \
 *     [--only=10.8.1.250]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:tls";
import type { TLSSocket } from "node:tls";
import type { Socket } from "node:net";

const args = process.argv.slice(2);
const flag = (name: string, def: string): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const port = Number(flag("port", "50443"));
const certPath = resolve(flag("cert", "tmp/listener-cert.pem"));
const keyPath = resolve(flag("key", "tmp/listener-key.pem"));

/** The device under test — its connections get flagged in the log. */
const DEVICE_IP = "10.8.1.250";
/** Only this IP is engaged; every other client is dropped at TCP accept. `any` = no filter. */
const only = flag("only", DEVICE_IP);

const ts = (): string => new Date().toLocaleTimeString();
const cleanIp = (s?: string): string => (s ?? "?").replace(/^::ffff:/, "");
const tag = (ip: string): string => (ip === DEVICE_IP ? "  ← PANTRY LIGHT" : "");

/** Classic offset/hex/ascii dump, capped so a chatty device can't flood the log. */
function hexDump(buf: Buffer, cap = 512): string {
  const view = buf.subarray(0, cap);
  const lines: string[] = [];
  for (let i = 0; i < view.length; i += 16) {
    const slice = view.subarray(i, i + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`    ${i.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (buf.length > cap) lines.push(`    ... (${buf.length - cap} more bytes)`);
  return lines.join("\n");
}

const server = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (socket: TLSSocket) => {
    const ip = cleanIp(socket.remoteAddress);
    console.log(
      `[${ts()}] ✓ TLS handshake OK from ${ip}${tag(ip)}  ` +
        `proto=${socket.getProtocol()}  cipher=${socket.getCipher()?.name}  sni=${socket.servername || "(none)"}`
    );
    socket.on("data", (d: Buffer) => {
      console.log(`[${ts()}]   ${ip} sent ${d.length} bytes:`);
      console.log(hexDump(d));
    });
    socket.on("close", () => console.log(`[${ts()}]   ${ip} disconnected`));
    socket.on("error", (e) => console.log(`[${ts()}]   ${ip} socket error: ${e.message}`));
  }
);

server.on("connection", (sock: Socket) => {
  const ip = cleanIp(sock.remoteAddress);
  if (only !== "any" && ip !== only) {
    console.log(`[${ts()}] · dropped ${ip} — not the target (${only})`);
    sock.destroy();
    return;
  }
  console.log(`[${ts()}] · TCP connection from ${ip}${tag(ip)}`);
});
server.on("tlsClientError", (err: Error, sock: TLSSocket) => {
  const ip = cleanIp(sock.remoteAddress);
  console.log(`[${ts()}] ✗ TLS handshake FAILED from ${ip}${tag(ip)} — ${err.message}`);
});
server.on("error", (e) => console.error(`server error: ${e.message}`));

server.listen(port, "0.0.0.0", () => {
  console.log(`Kasa cloud listener — TLS on 0.0.0.0:${port}`);
  console.log(`  cert: ${certPath}`);
  console.log(`  engaging: ${only === "any" ? "every client" : only + " only (others dropped)"}`);
  console.log(`Waiting for a device to dial in. Ctrl-C to stop.\n`);
});
