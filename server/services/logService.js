'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const MAX_LINES = 200;

function readLogFile(filePath, lines) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const allLines = content.split('\n').filter(l => l.length > 0);
    return allLines.slice(-lines);
  } catch {
    return null;
  }
}

// Read all matching log files and merge + sort by filename timestamp prefix.
function readLogFiles(pattern, lines) {
  let entries;
  try {
    entries = fs.readdirSync('/var/log').filter(f => f.match(pattern));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const allLines = [];
  for (const name of entries) {
    const result = readLogFile(`/var/log/${name}`, lines);
    if (result) allLines.push(...result);
  }
  return allLines.length > 0 ? allLines.slice(-lines) : null;
}

async function getServiceLogs(unit, lines) {
  try {
    const { stdout } = await execFileAsync('journalctl', [
      '-u', unit,
      '-n', String(lines),
      '--no-pager',
      '--output', 'short-iso',
    ]);
    return stdout.split('\n').filter(l => l.length > 0);
  } catch {
    return null;
  }
}

async function getLogs({ lines = MAX_LINES } = {}) {
  const n = Math.min(Math.max(1, parseInt(lines, 10) || MAX_LINES), 500);

  // hostapd: read from /var/log/piap-hostapd-*.log (direct process, not systemd)
  const hostapdLines = readLogFiles(/^piap-hostapd-.+\.log$/, n)
    || [`[no hostapd log files found in /var/log]`];

  // dnsmasq: read from /var/log/piap-dnsmasq-*.log
  const dnsmasqLines = readLogFiles(/^piap-dnsmasq-.+\.log$/, n)
    || [`[no dnsmasq log files found in /var/log]`];

  // piap app: systemd-managed, use journalctl
  const piapLines = await getServiceLogs('piap', n)
    || [`[unable to read logs for piap]`];

  return {
    hostapd: hostapdLines,
    dnsmasq: dnsmasqLines,
    piap: piapLines,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getLogs };
