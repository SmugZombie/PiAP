#!/usr/bin/env bash
# update.sh — pull latest changes from git and restart PiAP.
# Run from /opt/piap as the piap user (or root):
#   cd /opt/piap && sudo bash update.sh
set -euo pipefail

INSTALL_DIR="/opt/piap"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[piap]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }

[[ "$EUID" -eq 0 ]] || { echo "Run as root: sudo bash update.sh"; exit 1; }

cd "${INSTALL_DIR}"

# ── Pull latest ───────────────────────────────────────────────────────────────
log "Pulling latest changes…"
# Run git as the piap user so ownership stays correct
sudo -u piap git pull --ff-only

# ── npm install (only if package.json changed) ────────────────────────────────
if git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -q "package.json"; then
  log "package.json changed — running npm install…"
  npm install --omit=dev
else
  log "package.json unchanged — skipping npm install"
fi

# ── Update sudoers if changed ─────────────────────────────────────────────────
if ! diff -q "${INSTALL_DIR}/scripts/sudoers-piap" /etc/sudoers.d/piap &>/dev/null; then
  log "Updating sudoers rules…"
  cp "${INSTALL_DIR}/scripts/sudoers-piap" /etc/sudoers.d/piap
  chmod 440 /etc/sudoers.d/piap
  visudo -c -f /etc/sudoers.d/piap || { echo "ERROR: sudoers invalid, reverting"; rm /etc/sudoers.d/piap; exit 1; }
fi

# ── Make scripts executable ───────────────────────────────────────────────────
chmod 750 "${INSTALL_DIR}/scripts"/*.sh
chown root:piap "${INSTALL_DIR}/scripts"/*.sh

# ── Reload systemd if service file changed ────────────────────────────────────
if ! diff -q "${INSTALL_DIR}/piap.service" /etc/systemd/system/piap.service &>/dev/null; then
  log "Service file changed — reloading systemd…"
  cp "${INSTALL_DIR}/piap.service" /etc/systemd/system/piap.service
  systemctl daemon-reload
fi

# ── Restart app ───────────────────────────────────────────────────────────────
log "Restarting piap service…"
systemctl restart piap
systemctl is-active piap && log "piap is running" || warn "piap failed to start — check: journalctl -u piap -n 50"
