#!/usr/bin/env bash
# update.sh — pull latest changes from git and restart PiAP.
# Run from /opt/piap as the piap user (or root):
#   cd /opt/piap && sudo bash update.sh
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[piap]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }

[[ "$EUID" -eq 0 ]] || { echo "Run as root: sudo bash update.sh"; exit 1; }

cd "${INSTALL_DIR}"

# ── Pull latest ───────────────────────────────────────────────────────────────
log "Pulling latest changes…"
git pull --ff-only

# ── npm install (if node_modules missing or package.json changed) ─────────────
if [[ ! -d "${INSTALL_DIR}/node_modules" ]] || git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -q "package.json"; then
  log "Running npm install…"
  npm install --omit=dev
else
  log "node_modules present and package.json unchanged — skipping npm install"
fi

# ── Update sudoers if changed ─────────────────────────────────────────────────
STAMPED_SUDOERS="$(sed "s|/opt/piap|${INSTALL_DIR}|g" "${INSTALL_DIR}/scripts/sudoers-piap")"
if [[ "${STAMPED_SUDOERS}" != "$(cat /etc/sudoers.d/piap 2>/dev/null)" ]]; then
  log "Updating sudoers rules…"
  echo "${STAMPED_SUDOERS}" > /etc/sudoers.d/piap
  chmod 440 /etc/sudoers.d/piap
  visudo -c -f /etc/sudoers.d/piap || { echo "ERROR: sudoers invalid, reverting"; rm /etc/sudoers.d/piap; exit 1; }
fi

# ── Make scripts executable ───────────────────────────────────────────────────
chmod 750 "${INSTALL_DIR}/scripts"/*.sh
chown root:piap "${INSTALL_DIR}/scripts"/*.sh

# ── Reload systemd if service file changed ────────────────────────────────────
STAMPED_SERVICE="$(sed "s|/opt/piap|${INSTALL_DIR}|g" "${INSTALL_DIR}/piap.service")"
if [[ "${STAMPED_SERVICE}" != "$(cat /etc/systemd/system/piap.service 2>/dev/null)" ]]; then
  log "Service file changed — reloading systemd…"
  echo "${STAMPED_SERVICE}" > /etc/systemd/system/piap.service
  systemctl daemon-reload
fi

# ── Restart app ───────────────────────────────────────────────────────────────
log "Restarting piap service…"
systemctl restart piap
systemctl is-active piap && log "piap is running" || warn "piap failed to start — check: journalctl -u piap -n 50"
