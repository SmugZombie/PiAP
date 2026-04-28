'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const SCRIPTS_DIR  = path.join(__dirname, '..', '..', 'scripts');
const SCAN_SCRIPT  = path.join(SCRIPTS_DIR, 'wifi-scan.sh');
const HISTORY_FILE = path.join(__dirname, '..', '..', 'data', 'scan-history.json');
const SETTINGS_FILE = path.join(__dirname, '..', '..', 'data', 'scanner-settings.json');

const DEFAULTS = { interface: 'wlan1', intervalSeconds: 60, enabled: false };

let scanTimer = null;

// ── Persistence ───────────────────────────────────────────────────────────────

function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function writeSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return { lastScan: null, networks: {} }; }
}

function writeHistory(h) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2), 'utf8');
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function freqToChannel(freq) {
  if (freq === 2484) return 14;
  if (freq >= 2412 && freq <= 2472) return Math.round((freq - 2412) / 5) + 1;
  if (freq >= 5170) return Math.round((freq - 5170) / 5) + 34;
  return null;
}

function parseIwScan(output) {
  const networks = [];
  let cur = null;
  for (const line of output.split('\n')) {
    const bssMatch = line.match(/^BSS ([0-9a-f:]{17})/i);
    if (bssMatch) {
      if (cur) networks.push(cur);
      cur = { bssid: bssMatch[1].toLowerCase(), ssid: '', signal: null, frequency: null, channel: null, security: 'Open' };
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = line.match(/^\s+SSID: (.*)$/)))           cur.ssid      = m[1];
    if ((m = line.match(/^\s+signal: ([-\d.]+) dBm/))) cur.signal    = parseFloat(m[1]);
    if ((m = line.match(/^\s+freq: (\d+)/))) {
      cur.frequency = parseInt(m[1], 10);
      cur.channel   = freqToChannel(cur.frequency);
    }
    if (line.match(/^\s+RSN:/))                        cur.security  = 'WPA2';
    else if (line.match(/^\s+WPA:/) && cur.security !== 'WPA2') cur.security = 'WPA';
  }
  if (cur) networks.push(cur);
  return networks;
}

// ── Core scan ─────────────────────────────────────────────────────────────────

async function runScan() {
  const settings = readSettings();
  const iface = settings.interface || 'wlan1';

  const { stdout } = await execFileAsync('sudo', [SCAN_SCRIPT, iface], { timeout: 20000 });
  const found = parseIwScan(stdout);

  const history = readHistory();
  const now = new Date().toISOString();
  history.lastScan = now;

  for (const net of found) {
    const existing = history.networks[net.bssid];
    history.networks[net.bssid] = existing
      ? { ...existing, ...net, lastSeen: now, seenCount: (existing.seenCount || 0) + 1 }
      : { ...net, firstSeen: now, lastSeen: now, seenCount: 1 };
  }

  writeHistory(history);
  return found;
}

// ── Auto-scan timer ───────────────────────────────────────────────────────────

function startAutoScan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  const settings = readSettings();
  if (!settings.enabled) return;
  const ms = Math.max(10, settings.intervalSeconds) * 1000;
  runScan().catch(e => console.error('[scanner]', e.message));
  scanTimer = setInterval(
    () => runScan().catch(e => console.error('[scanner]', e.message)),
    ms
  );
}

function stopAutoScan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

// ── Public API ────────────────────────────────────────────────────────────────

function getHistory() {
  const h = readHistory();
  return {
    lastScan: h.lastScan,
    totalSeen: Object.keys(h.networks).length,
    networks: Object.values(h.networks)
      .sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999)),
  };
}

async function applySettings(data) {
  const current = readSettings();
  if (data.interface !== undefined)       current.interface       = String(data.interface).trim();
  if (data.intervalSeconds !== undefined) current.intervalSeconds = Math.max(10, parseInt(data.intervalSeconds, 10) || 60);
  if (data.enabled !== undefined)         current.enabled         = Boolean(data.enabled);
  writeSettings(current);
  if (current.enabled) startAutoScan(); else stopAutoScan();
  return current;
}

function clearHistory() {
  writeHistory({ lastScan: null, networks: {} });
}

module.exports = { runScan, getHistory, getSettings: readSettings, applySettings, startAutoScan, clearHistory };
