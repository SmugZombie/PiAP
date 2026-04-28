'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
const APPLY_SCRIPT = path.join(SCRIPTS_DIR, 'apply-profile.sh');
const STOP_SCRIPT = path.join(SCRIPTS_DIR, 'stop-ap.sh');

function assertSafeString(val, name) {
  if (typeof val !== 'string') throw new Error(`${name} must be a string`);
  if (/[`$\\|;&<>(){}\n\r]/.test(val)) throw new Error(`${name} contains unsafe characters`);
}

// Write JSON to a mode-600 temp file; return the path.
// The shell script reads the file and deletes it immediately.
// This avoids sudo's env_reset stripping the variable.
function writeTempJson(data) {
  const tmpPath = path.join(os.tmpdir(), `piap-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
  return tmpPath;
}

async function startNetwork(profile) {
  assertSafeString(profile.ssid, 'SSID');
  assertSafeString(profile.password, 'password');
  assertSafeString(profile.gateway, 'gateway');
  assertSafeString(profile.subnet, 'subnet');
  assertSafeString(profile.dhcpStart, 'dhcpStart');
  assertSafeString(profile.dhcpEnd, 'dhcpEnd');

  const tmpFile = writeTempJson(profile);
  try {
    const { stdout, stderr } = await execFileAsync('sudo', [APPLY_SCRIPT, tmpFile], {
      timeout: 30000,
    });
    return { stdout, stderr };
  } finally {
    // Best-effort cleanup in case the script didn't remove it
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function stopNetwork() {
  const { stdout, stderr } = await execFileAsync('sudo', [STOP_SCRIPT], {
    timeout: 20000,
  });
  return { stdout, stderr };
}

async function isHostapdRunning() {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', 'hostapd']);
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
}

async function isDnsmasqRunning() {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', 'dnsmasq']);
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
}

async function getSystemStatus() {
  const [hostapdActive, dnsmasqActive] = await Promise.all([
    isHostapdRunning(),
    isDnsmasqRunning(),
  ]);
  return { hostapdActive, dnsmasqActive };
}

module.exports = { startNetwork, stopNetwork, getSystemStatus };
