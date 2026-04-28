'use strict';

// Manages multi-interface, multi-BSS AP state.
//
// State (persisted to data/network-state.json):
//   { [phy]: { primaryIface, profiles: [{profileId, logicalIface}] } }
//
// When multiple profiles share the same physical radio (phy), hostapd runs
// one process with a multi-BSS config. Profiles on different radios get
// separate hostapd processes. All BSSes on the same radio share the channel
// of the first (primary) profile.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);
const interfaceService = require('./interfaceService');
const profileService = require('./profileService');

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
const APPLY_PHY_SCRIPT = path.join(SCRIPTS_DIR, 'apply-phy.sh');
const STATE_FILE = path.join(__dirname, '..', '..', 'data', 'network-state.json');

// ── State helpers ─────────────────────────────────────────────────────────────

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// Returns the set of virtual interface names currently allocated.
function usedVirtualIfaces(state) {
  const used = new Set();
  for (const phy of Object.values(state)) {
    for (const p of phy.profiles) {
      if (p.logicalIface.startsWith('piap')) used.add(p.logicalIface);
    }
  }
  return used;
}

function nextVirtualIface(state) {
  const used = usedVirtualIfaces(state);
  for (let i = 0; i < 20; i++) {
    const name = `piap${i}`;
    if (!used.has(name)) return name;
  }
  throw new Error('No virtual interface slots available (max 20)');
}

// ── Script invocation ─────────────────────────────────────────────────────────

function writeTempJson(data) {
  const tmpPath = path.join(os.tmpdir(), `piap-phy-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
  return tmpPath;
}

async function applyPhy(phy, primaryIface, activeEntries) {
  // activeEntries: [{ profileId, logicalIface, ...profileFields }]
  const config = { phy, primaryIface, profiles: activeEntries };
  const tmpFile = writeTempJson(config);
  try {
    const { stdout, stderr } = await execFileAsync('sudo', [APPLY_PHY_SCRIPT, tmpFile], {
      timeout: 45000,
    });
    return { stdout, stderr };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function startNetwork(profile) {
  const iface = profile.interface || 'wlan0';
  const phy = await interfaceService.getPhyForInterface(iface);
  if (!phy) throw new Error(`Interface ${iface} not found or not available`);

  const supportsAP = await interfaceService.phySupportsAP(phy);
  if (!supportsAP) {
    throw new Error(`Interface ${iface} (${phy}) does not support AP mode. Use a different adapter.`);
  }

  const state = readState();

  // Already active on some phy?
  for (const phyState of Object.values(state)) {
    if (phyState.profiles.some(p => p.profileId === profile.id)) {
      throw new Error('Profile is already active');
    }
  }

  if (!state[phy]) state[phy] = { primaryIface: iface, profiles: [] };

  // Assign logical interface
  const isFirst = state[phy].profiles.length === 0;
  const logicalIface = isFirst ? iface : nextVirtualIface(state);

  if (isFirst) state[phy].primaryIface = iface;

  state[phy].profiles.push({ profileId: profile.id, logicalIface });

  // Build full entry list for this phy
  const entries = buildEntries(state[phy]);

  try {
    const result = await applyPhy(phy, state[phy].primaryIface, entries);
    writeState(state);
    return result;
  } catch (err) {
    // Roll back so a retry gets the same (correct) slot assignment
    state[phy].profiles = state[phy].profiles.filter(p => p.profileId !== profile.id);
    if (state[phy].profiles.length === 0) delete state[phy];
    throw err;
  }
}

async function stopNetwork(profileId) {
  const state = readState();
  let foundPhy = null;

  for (const [phy, phyState] of Object.entries(state)) {
    if (phyState.profiles.some(p => p.profileId === profileId)) {
      foundPhy = phy;
      break;
    }
  }
  if (!foundPhy) throw new Error('Profile not found in active state');

  state[foundPhy].profiles = state[foundPhy].profiles.filter(p => p.profileId !== profileId);

  let result;
  if (state[foundPhy].profiles.length === 0) {
    result = await applyPhy(foundPhy, state[foundPhy].primaryIface, []);
    delete state[foundPhy];
  } else {
    const entries = buildEntries(state[foundPhy]);
    result = await applyPhy(foundPhy, state[foundPhy].primaryIface, entries);
  }

  writeState(state);
  return result;
}

// Reset all active state on startup — processes don't survive reboot.
function resetOnStartup() {
  writeState({});
  const profiles = profileService.getAll();
  profiles.forEach(p => {
    if (p.active) profileService.setActive(p.id, false);
  });
}

function buildEntries(phyState) {
  return phyState.profiles.map(({ profileId, logicalIface }) => {
    const profile = profileService.getById(profileId);
    return { ...profile, logicalIface };
  });
}

// Returns per-phy status keyed by phy name.
function getNetworkState() {
  return readState();
}

function isPidAlive(pidFile) {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getSystemStatus() {
  const state = readState();
  const result = {};
  for (const [phy, phyState] of Object.entries(state)) {
    result[phy] = {
      primaryIface: phyState.primaryIface,
      hostapdRunning: isPidAlive(`/run/piap-hostapd-${phy}.pid`),
      profiles: phyState.profiles.map(p => ({
        ...p,
        dnsmasqRunning: isPidAlive(`/run/piap-dnsmasq-${p.logicalIface}.pid`),
      })),
    };
  }
  return result;
}

module.exports = { startNetwork, stopNetwork, resetOnStartup, getNetworkState, getSystemStatus };
