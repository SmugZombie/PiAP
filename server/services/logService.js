'use strict';

const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const MAX_LINES = 200;

async function getServiceLogs(unit, lines = MAX_LINES) {
  const n = Math.min(Math.max(1, parseInt(lines, 10) || MAX_LINES), 500);
  try {
    const { stdout } = await execFileAsync('journalctl', [
      '-u', unit,
      '-n', String(n),
      '--no-pager',
      '--output', 'short-iso',
    ]);
    return stdout.split('\n').filter(l => l.length > 0);
  } catch {
    return [`[unable to read logs for ${unit}]`];
  }
}

async function getLogs({ lines = MAX_LINES } = {}) {
  const [hostapd, dnsmasq, piap] = await Promise.all([
    getServiceLogs('hostapd', lines),
    getServiceLogs('dnsmasq', lines),
    getServiceLogs('piap', lines),
  ]);

  return {
    hostapd,
    dnsmasq,
    piap,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getLogs };
