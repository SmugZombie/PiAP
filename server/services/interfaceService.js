'use strict';

const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

// Parse `iw dev` output into { [phy]: { interfaces: [...] } }
async function parseIwDev() {
  const { stdout } = await execFileAsync('iw', ['dev']);
  const phys = {};
  let currentPhy = null;
  let currentIface = null;

  for (const line of stdout.split('\n')) {
    // phy#0 or phy#1 etc
    const phyMatch = line.match(/^phy#(\d+)/);
    if (phyMatch) {
      currentPhy = `phy${phyMatch[1]}`;
      phys[currentPhy] = { phy: currentPhy, interfaces: [] };
      currentIface = null;
      continue;
    }

    const ifaceMatch = line.match(/^\s+Interface\s+(\S+)/);
    if (ifaceMatch && currentPhy) {
      currentIface = { name: ifaceMatch[1], phy: currentPhy, type: 'unknown', mac: '', channel: null };
      phys[currentPhy].interfaces.push(currentIface);
      continue;
    }

    if (currentIface) {
      const m = line.match(/^\s+type\s+(\S+)/);
      if (m) currentIface.type = m[1];

      const a = line.match(/^\s+addr\s+(\S+)/);
      if (a) currentIface.mac = a[1];

      const c = line.match(/^\s+channel\s+(\d+)/);
      if (c) currentIface.channel = parseInt(c[1], 10);
    }
  }

  return phys;
}

async function phySupportsAP(phy) {
  try {
    const { stdout } = await execFileAsync('iw', ['phy', phy, 'info']);
    // Only check within the "Supported interface modes:" section.
    // stdout.includes('* AP') is a false positive — the TX frame types section
    // also lists "* AP: 0x00 ..." with a colon, and that's not AP mode support.
    const start = stdout.indexOf('Supported interface modes:');
    if (start === -1) return false;
    const section = stdout.slice(start + 'Supported interface modes:'.length);
    for (const line of section.split('\n')) {
      if (!line.match(/^\s+\*/)) break; // end of mode list (next section started)
      if (/\*\s+AP\s*$/.test(line)) return true; // "* AP" alone, no colon after
    }
    return false;
  } catch {
    return false;
  }
}

// Returns all real (non-virtual) Wi-Fi interfaces with AP capability info.
async function listWifiInterfaces() {
  const phys = await parseIwDev();
  const result = [];

  for (const [phyName, phyData] of Object.entries(phys)) {
    const supportsAP = await phySupportsAP(phyName);
    for (const iface of phyData.interfaces) {
      // Skip virtual interfaces we created
      if (iface.name.startsWith('piap')) continue;
      result.push({
        name: iface.name,
        phy: phyName,
        type: iface.type,
        mac: iface.mac,
        channel: iface.channel,
        supportsAP,
      });
    }
  }

  return result;
}

// Returns the phy name for a given interface name, or null.
async function getPhyForInterface(ifaceName) {
  const phys = await parseIwDev();
  for (const [phyName, phyData] of Object.entries(phys)) {
    if (phyData.interfaces.some(i => i.name === ifaceName)) return phyName;
  }
  return null;
}

module.exports = { listWifiInterfaces, getPhyForInterface, phySupportsAP };
