'use strict';

const fs = require('fs');

const LEASES_FILE = '/var/lib/misc/dnsmasq.leases';

// Parse /var/lib/misc/dnsmasq.leases
// Format: <expiry-epoch> <mac> <ip> <hostname> <client-id>
function parseLeases() {
  let raw;
  try {
    raw = fs.readFileSync(LEASES_FILE, 'utf8');
  } catch {
    return [];
  }

  const now = Math.floor(Date.now() / 1000);

  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return null;
      const [expiry, mac, ip, hostname, clientId] = parts;
      const expiryTs = parseInt(expiry, 10);
      return {
        mac: mac.toLowerCase(),
        ip,
        hostname: hostname === '*' ? '(unknown)' : hostname,
        clientId: clientId || '*',
        expiresAt: expiryTs === 0 ? null : new Date(expiryTs * 1000).toISOString(),
        expired: expiryTs !== 0 && expiryTs < now,
      };
    })
    .filter(Boolean)
    .filter(l => !l.expired);
}

module.exports = { parseLeases };
