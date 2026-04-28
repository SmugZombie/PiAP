'use strict';

const { execFile } = require('child_process');
const path = require('path');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
const APPLY_SCRIPT = path.join(SCRIPTS_DIR, 'apply-profile.sh');
const STOP_SCRIPT = path.join(SCRIPTS_DIR, 'stop-ap.sh');

// Validate that a profile's fields are safe to pass to shell scripts.
// We pass data as JSON via stdin/env, but we double-check here anyway.
function assertSafeString(val, name) {
  if (typeof val !== 'string') throw new Error(`${name} must be a string`);
  // Reject any shell metacharacters
  if (/[`$\\|;&<>(){}\n\r]/.test(val)) throw new Error(`${name} contains unsafe characters`);
}

async function startNetwork(profile) {
  assertSafeString(profile.ssid, 'SSID');
  assertSafeString(profile.password, 'password');
  assertSafeString(profile.gateway, 'gateway');
  assertSafeString(profile.subnet, 'subnet');
  assertSafeString(profile.dhcpStart, 'dhcpStart');
  assertSafeString(profile.dhcpEnd, 'dhcpEnd');

  // Pass the entire profile as a JSON environment variable so no shell interpolation occurs
  const env = {
    ...process.env,
    PIAP_PROFILE: JSON.stringify(profile),
  };

  const { stdout, stderr } = await execFileAsync('sudo', [APPLY_SCRIPT], {
    env,
    timeout: 30000,
  });

  return { stdout, stderr };
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
