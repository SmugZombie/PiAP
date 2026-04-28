'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'profiles.json');

// Subnet pool: 10.55.X.0/24 where X starts at 1
const SUBNET_BASE_THIRD_OCTET_START = 1;

function readProfiles() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeProfiles(profiles) {
  fs.writeFileSync(DB_PATH, JSON.stringify(profiles, null, 2), 'utf8');
}

function nextAvailableSubnet(profiles) {
  const usedOctets = new Set(
    profiles.map(p => {
      const m = p.subnet.match(/^10\.(\d+)\.\d+\.\d+/);
      return m ? parseInt(m[1], 10) : null;
    }).filter(Boolean)
  );
  let octet = SUBNET_BASE_THIRD_OCTET_START;
  while (usedOctets.has(octet) && octet < 254) octet++;
  return {
    subnet: `10.${octet}.0.0/24`,
    gateway: `10.${octet}.0.1`,
    dhcpStart: `10.${octet}.0.50`,
    dhcpEnd: `10.${octet}.0.200`,
  };
}

function validateSsid(ssid) {
  // IEEE 802.11: max 32 bytes, printable ASCII, no leading/trailing space
  if (typeof ssid !== 'string') return false;
  const trimmed = ssid.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return false;
  if (!/^[\x20-\x7E]+$/.test(trimmed)) return false;
  return true;
}

function validatePassword(pw) {
  if (typeof pw !== 'string') return false;
  if (pw.length < 8 || pw.length > 63) return false;
  // printable ASCII only
  if (!/^[\x20-\x7E]+$/.test(pw)) return false;
  return true;
}

function validateIp(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
    ip.split('.').every(n => parseInt(n, 10) <= 255);
}

function validateSubnet(subnet) {
  const m = subnet.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!m) return false;
  const prefix = parseInt(m[2], 10);
  return validateIp(m[1]) && prefix >= 8 && prefix <= 30;
}

function getAll() {
  return readProfiles();
}

function getById(id) {
  return readProfiles().find(p => p.id === id) || null;
}

function create(data) {
  const profiles = readProfiles();

  if (!validateSsid(data.ssid)) throw new Error('Invalid SSID');
  if (!validatePassword(data.password)) throw new Error('Invalid password (8-63 printable ASCII chars)');
  if (profiles.some(p => p.ssid === data.ssid.trim())) {
    throw new Error(`SSID "${data.ssid.trim()}" already exists`);
  }

  const autoNet = nextAvailableSubnet(profiles);

  const profile = {
    id: uuidv4(),
    ssid: data.ssid.trim(),
    password: data.password,
    interface: typeof data.interface === 'string' && data.interface.trim() ? data.interface.trim() : 'wlan0',
    subnet: data.subnet && validateSubnet(data.subnet) ? data.subnet : autoNet.subnet,
    gateway: data.gateway && validateIp(data.gateway) ? data.gateway : autoNet.gateway,
    dhcpStart: data.dhcpStart && validateIp(data.dhcpStart) ? data.dhcpStart : autoNet.dhcpStart,
    dhcpEnd: data.dhcpEnd && validateIp(data.dhcpEnd) ? data.dhcpEnd : autoNet.dhcpEnd,
    internetAccess: data.internetAccess === true,
    lanAccess: data.lanAccess === true,
    captivePortal: data.captivePortal !== false,
    captiveMessage: typeof data.captiveMessage === 'string' ? data.captiveMessage.slice(0, 500) : 'This is a test/lab network. No internet access.',
    active: false,
    channel: Number.isInteger(data.channel) && data.channel >= 1 && data.channel <= 13 ? data.channel : 6,
  };

  profiles.push(profile);
  writeProfiles(profiles);
  return profile;
}

function update(id, data) {
  const profiles = readProfiles();
  const idx = profiles.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Profile not found');
  if (profiles[idx].active) throw new Error('Stop the network before editing');

  const p = profiles[idx];

  if (data.ssid !== undefined) {
    if (!validateSsid(data.ssid)) throw new Error('Invalid SSID');
    if (profiles.some((x, i) => i !== idx && x.ssid === data.ssid.trim())) {
      throw new Error(`SSID "${data.ssid.trim()}" already exists`);
    }
    p.ssid = data.ssid.trim();
  }
  if (data.password !== undefined) {
    if (!validatePassword(data.password)) throw new Error('Invalid password');
    p.password = data.password;
  }
  if (data.captivePortal !== undefined) p.captivePortal = data.captivePortal === true;
  if (data.captiveMessage !== undefined) p.captiveMessage = String(data.captiveMessage).slice(0, 500);
  if (data.internetAccess !== undefined) p.internetAccess = data.internetAccess === true;
  if (data.lanAccess !== undefined) p.lanAccess = data.lanAccess === true;
  if (data.channel !== undefined && Number.isInteger(data.channel) && data.channel >= 1 && data.channel <= 13) {
    p.channel = data.channel;
  }
  if (data.interface !== undefined && typeof data.interface === 'string' && data.interface.trim()) {
    p.interface = data.interface.trim();
  }

  writeProfiles(profiles);
  return p;
}

function remove(id) {
  const profiles = readProfiles();
  const idx = profiles.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Profile not found');
  if (profiles[idx].active) throw new Error('Stop the network before deleting');
  profiles.splice(idx, 1);
  writeProfiles(profiles);
}

function setActive(id, active) {
  const profiles = readProfiles();
  const idx = profiles.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Profile not found');
  profiles[idx].active = active;
  writeProfiles(profiles);
  return profiles[idx];
}

function getActiveProfiles() {
  return readProfiles().filter(p => p.active);
}

module.exports = { getAll, getById, create, update, remove, setActive, getActiveProfiles };
