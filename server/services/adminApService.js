'use strict';

// Manages the dedicated admin Wi-Fi AP on wlan1.
// The admin AP is always-on, password-protected, and provides access
// to the PiAP web UI. It is completely separate from the guest/lab
// network on wlan0.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const ADMIN_CONFIG_DIR = '/etc/piap';
const HOSTAPD_ADMIN_CONF = path.join(ADMIN_CONFIG_DIR, 'hostapd-admin.conf');
const DNSMASQ_ADMIN_CONF = path.join(ADMIN_CONFIG_DIR, 'dnsmasq-admin.conf');
const SETTINGS_FILE = path.join(__dirname, '..', '..', 'data', 'admin-ap.json');

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
const ADMIN_APPLY_SCRIPT = path.join(SCRIPTS_DIR, 'apply-admin-ap.sh');
const ADMIN_STOP_SCRIPT = path.join(SCRIPTS_DIR, 'stop-admin-ap.sh');

const DEFAULTS = {
  enabled: false,
  interface: 'wlan1',
  ssid: 'PiAP-Admin',
  password: 'ChangeMe123!',
  gateway: '192.168.200.1',
  dhcpStart: '192.168.200.10',
  dhcpEnd: '192.168.200.50',
  channel: 1,
};

function readSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

function validateSsid(ssid) {
  if (typeof ssid !== 'string') return false;
  const t = ssid.trim();
  return t.length >= 1 && t.length <= 32 && /^[\x20-\x7E]+$/.test(t);
}

function validatePassword(pw) {
  if (typeof pw !== 'string') return false;
  return pw.length >= 8 && pw.length <= 63 && /^[\x20-\x7E]+$/.test(pw);
}

function getSettings() {
  const s = readSettings();
  const safe = { ...s };
  // Never expose password through the API
  delete safe.password;
  return safe;
}

async function applySettings(data) {
  const current = readSettings();

  if (data.ssid !== undefined) {
    if (!validateSsid(data.ssid)) throw new Error('Invalid SSID');
    current.ssid = data.ssid.trim();
  }
  if (data.password !== undefined) {
    if (!validatePassword(data.password)) throw new Error('Invalid password (8-63 printable ASCII chars)');
    current.password = data.password;
  }
  if (data.channel !== undefined) {
    const ch = parseInt(data.channel, 10);
    if (ch < 1 || ch > 13) throw new Error('Channel must be 1-13');
    current.channel = ch;
  }

  writeSettings(current);
  return getSettings();
}

async function start() {
  const settings = readSettings();
  const env = { ...process.env, PIAP_ADMIN_AP: JSON.stringify(settings) };

  const { stdout, stderr } = await execFileAsync('sudo', [ADMIN_APPLY_SCRIPT], {
    env,
    timeout: 30000,
  });

  settings.enabled = true;
  writeSettings(settings);

  return { stdout, stderr };
}

async function stop() {
  const { stdout, stderr } = await execFileAsync('sudo', [ADMIN_STOP_SCRIPT], {
    timeout: 20000,
  });

  const settings = readSettings();
  settings.enabled = false;
  writeSettings(settings);

  return { stdout, stderr };
}

async function isRunning() {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', 'hostapd-admin']);
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
}

module.exports = { getSettings, applySettings, start, stop, isRunning };
