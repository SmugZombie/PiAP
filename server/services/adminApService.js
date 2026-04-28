'use strict';

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);
const interfaceService = require('./interfaceService');

const ADMIN_CONFIG_DIR = '/etc/piap';
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
  delete safe.password;
  return safe;
}

async function applySettings(data) {
  const current = readSettings();

  if (data.interface !== undefined) {
    const iface = String(data.interface).trim();
    const phy = await interfaceService.getPhyForInterface(iface);
    if (!phy) throw new Error(`Interface ${iface} not found`);
    const supportsAP = await interfaceService.phySupportsAP(phy);
    if (!supportsAP) throw new Error(`Interface ${iface} does not support AP mode`);
    current.interface = iface;
  }
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

function writeTempJson(data) {
  const tmpPath = path.join(os.tmpdir(), `piap-admin-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
  return tmpPath;
}

async function start() {
  const settings = readSettings();

  const phy = await interfaceService.getPhyForInterface(settings.interface);
  if (!phy) throw new Error(`Interface ${settings.interface} not found`);
  const supportsAP = await interfaceService.phySupportsAP(phy);
  if (!supportsAP) throw new Error(`Interface ${settings.interface} does not support AP mode. Change the interface in Admin AP settings.`);

  const tmpFile = writeTempJson(settings);
  try {
    const { stdout, stderr } = await execFileAsync('sudo', [ADMIN_APPLY_SCRIPT, tmpFile], {
      timeout: 30000,
    });
    settings.enabled = true;
    writeSettings(settings);
    return { stdout, stderr };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function stop() {
  const settings = readSettings();
  const iface = settings.interface || 'wlan1';
  const { stdout, stderr } = await execFileAsync('sudo', [ADMIN_STOP_SCRIPT, iface], {
    timeout: 20000,
  });
  settings.enabled = false;
  writeSettings(settings);
  return { stdout, stderr };
}

function isRunning() {
  try {
    const pid = parseInt(fs.readFileSync('/run/piap-hostapd-admin.pid', 'utf8').trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = { getSettings, applySettings, start, stop, isRunning };
