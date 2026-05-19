#!/usr/bin/env node
/**
 * Kasa cloud-server control — EXPERIMENTAL, scoped to one device.
 *
 * The `cnCloud` namespace lets a device be pointed at a different cloud
 * server (`set_server_url`). This tool backs up the current setting, can
 * redirect the device to our own host, and can restore the original.
 *
 * Hard safety rails:
 *   - Only ever touches the Pantry Light (ALLOWED_HOST), and re-checks the
 *     device alias before any write.
 *   - `redirect`/`restore` refuse to run unless a backup file exists, so
 *     the original server URL can always be put back.
 *   - The backup is written once and never overwritten.
 *
 * Usage:
 *   node --experimental-strip-types tools/cloud-ctl.mts <info|backup|redirect|restore|bind> [server]
 *
 *   info      print the device's current cnCloud config
 *   backup    save the current cnCloud config to tmp/pantry-cloud-backup.json
 *   redirect  point the device at `server` (default homelab.cldmv.net) + reboot
 *   restore   point the device back at the backed-up server + reboot
 *   bind      re-associate the device with a TP-Link cloud account. Reads
 *             credentials from env vars (kept out of argv and logs):
 *               KASA_CLOUD_PASS   — required (account password)
 *               KASA_CLOUD_USER   — optional (defaults to the backed-up username)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createKasaApi } from "../src/index.mts";

const ALLOWED_HOST = "10.8.1.250";
const EXPECTED_ALIAS = "Pantry Light";
const BACKUP_FILE = resolve("tmp/pantry-cloud-backup.json");

const MODE = process.argv[2];
const REDIRECT_SERVER = process.argv[3] ?? "homelab.cldmv.net";

if (!["info", "backup", "redirect", "restore", "bind"].includes(MODE ?? "")) {
  console.error("Usage: cloud-ctl.mts <info|backup|redirect|restore|bind> [server]");
  process.exit(1);
}

const api = await createKasaApi();
const target = { host: ALLOWED_HOST };

// Guard: prove we're talking to the Pantry Light and nothing else.
const sys = await api.device.info.get(target);
if (!sys.ok || !sys.value) {
  console.error(`Cannot reach ${ALLOWED_HOST}: ${sys.error ?? "no response"}`);
  process.exit(1);
}
if (sys.value.alias !== EXPECTED_ALIAS) {
  console.error(`Refusing: ${ALLOWED_HOST} alias is "${sys.value.alias}", expected "${EXPECTED_ALIAS}".`);
  process.exit(1);
}
console.log(`Target: "${sys.value.alias}" (${sys.value.model}) at ${ALLOWED_HOST}\n`);

/** Read the device's current cnCloud config. */
async function cloudInfo() {
  const r = await api.protocol.send(target, { cnCloud: { get_info: {} } });
  return (r.cnCloud?.get_info ?? {}) as Record<string, unknown>;
}

/** Send cnCloud.set_server_url; throws on a non-zero err_code. */
async function setServer(server: string) {
  const r = await api.protocol.send(target, { cnCloud: { set_server_url: { server } } });
  const res = r.cnCloud?.set_server_url as { err_code?: number; err_msg?: string } | undefined;
  if (!res || res.err_code !== 0) {
    throw new Error(`set_server_url rejected: ${JSON.stringify(res)}`);
  }
}

if (MODE === "info") {
  console.dir(await cloudInfo(), { depth: null });
  process.exit(0);
}

if (MODE === "backup") {
  if (existsSync(BACKUP_FILE)) {
    console.log(`Backup already exists — keeping the original, not overwriting:`);
    console.dir(JSON.parse(readFileSync(BACKUP_FILE, "utf8")), { depth: null });
    process.exit(0);
  }
  const cnCloud = await cloudInfo();
  const backup = { host: ALLOWED_HOST, alias: EXPECTED_ALIAS, savedAt: new Date().toISOString(), cnCloud };
  writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
  console.log(`Backed up cloud config → ${BACKUP_FILE}`);
  console.log(`Original server: ${cnCloud.server}`);
  process.exit(0);
}

if (MODE === "bind") {
  const backedUpUser = existsSync(BACKUP_FILE)
    ? (JSON.parse(readFileSync(BACKUP_FILE, "utf8")).cnCloud?.username as string | undefined)
    : undefined;
  const username = process.env.KASA_CLOUD_USER ?? backedUpUser;
  const password = process.env.KASA_CLOUD_PASS;
  if (!username) {
    console.error("No username — set KASA_CLOUD_USER (or have a backup file with one).");
    process.exit(1);
  }
  if (!password) {
    console.error("No password — set the KASA_CLOUD_PASS env var (kept out of argv and logs).");
    process.exit(1);
  }
  console.log(`bind: re-associating device with cloud account ${username} ...`);
  const r = await api.protocol.send(target, { cnCloud: { bind: { username, password } } });
  const res = r.cnCloud?.bind as { err_code?: number; err_msg?: string } | undefined;
  if (!res || res.err_code !== 0) {
    console.error(`✗ bind failed: ${JSON.stringify(res)}`);
    process.exit(1);
  }
  const after = await cloudInfo();
  console.log(
    after.binded === 1
      ? `✓ Re-bound — binded=1, username=${after.username}`
      : `⚠ bind returned ok but binded=${after.binded} — check the Kasa app.`
  );
  process.exit(0);
}

// redirect / restore — both require the backup as a safety net.
if (!existsSync(BACKUP_FILE)) {
  console.error(`No backup at ${BACKUP_FILE} — run \`backup\` first.`);
  process.exit(1);
}
const backup = JSON.parse(readFileSync(BACKUP_FILE, "utf8")) as { cnCloud: { server?: string } };
const originalServer = backup.cnCloud?.server;
if (!originalServer) {
  console.error("Backup file has no original server URL — aborting.");
  process.exit(1);
}

const newServer = MODE === "redirect" ? REDIRECT_SERVER : originalServer;
const before = await cloudInfo();
console.log(`${MODE}: cloud server  ${before.server}  →  ${newServer}`);

await setServer(newServer);
const after = await cloudInfo();
if (after.server !== newServer) {
  console.error(`✗ Verify failed — server is "${after.server}", expected "${newServer}".`);
  process.exit(1);
}
console.log(`✓ Cloud server is now: ${after.server}`);

// Reboot so the device drops the stale cloud link and re-dials the new one.
console.log("Rebooting device to force a fresh cloud connection ...");
const reboot = await api.device.reboot(target, 1);
console.log(reboot.ok ? "Device rebooting (~15-30s)." : `Reboot command failed: ${reboot.error}`);
process.exit(0);
