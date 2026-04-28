#!/usr/bin/env bash
# install.sh — PiAP full installation script for Raspberry Pi OS (Bookworm/Bullseye).
# Run as root: sudo bash install.sh
set -euo pipefail

PIAP_USER="piap"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${SCRIPT_DIR}"
CONFIG_DIR="/etc/piap"
DATA_DIR="${INSTALL_DIR}/data"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[piap]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
die()  { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

[[ "$EUID" -eq 0 ]] || die "Run this script as root: sudo bash install.sh"

# ── Detect OS ────────────────────────────────────────────────────────────────
if [[ ! -f /etc/os-release ]]; then die "Cannot detect OS"; fi
source /etc/os-release
log "Installing on: ${PRETTY_NAME}"

# ── Install system packages ──────────────────────────────────────────────────
log "Updating package lists…"
apt-get update -qq

log "Installing required packages…"
apt-get install -y \
  hostapd \
  dnsmasq \
  nftables \
  nodejs \
  npm \
  rfkill \
  iw \
  net-tools \
  python3

# Ensure hostapd is not blocked by rfkill
rfkill unblock wifi 2>/dev/null || true

# ── Verify Node.js version ───────────────────────────────────────────────────
NODE_VER="$(node --version | cut -c2- | cut -d. -f1)"
if [[ "${NODE_VER}" -lt 20 ]]; then
  warn "Node.js ${NODE_VER} found, but 20+ is required. Installing via NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
log "Node.js: $(node --version)"

# ── Create system user ───────────────────────────────────────────────────────
if ! id "${PIAP_USER}" &>/dev/null; then
  log "Creating system user '${PIAP_USER}'…"
  useradd --system --no-create-home --shell /usr/sbin/nologin "${PIAP_USER}"
fi

# ── Copy application files ───────────────────────────────────────────────────
log "Installing application to ${INSTALL_DIR}…"
mkdir -p "${INSTALL_DIR}"
rsync -a --exclude='.git' --exclude='node_modules' \
  "${SCRIPT_DIR}/" "${INSTALL_DIR}/"

# ── Install Node.js dependencies ─────────────────────────────────────────────
log "Installing npm dependencies…"
cd "${INSTALL_DIR}"
npm install --omit=dev

# ── Set up data directory ────────────────────────────────────────────────────
mkdir -p "${DATA_DIR}"
[[ -f "${DATA_DIR}/profiles.json" ]] || echo '[]' > "${DATA_DIR}/profiles.json"
[[ -f "${DATA_DIR}/admin-ap.json" ]] || cat > "${DATA_DIR}/admin-ap.json" << 'EOF'
{
  "enabled": false,
  "interface": "wlan1",
  "ssid": "PiAP-Admin",
  "password": "ChangeMe123!",
  "gateway": "192.168.200.1",
  "dhcpStart": "192.168.200.10",
  "dhcpEnd": "192.168.200.50",
  "channel": 1
}
EOF
warn "IMPORTANT: Change the admin AP password in ${DATA_DIR}/admin-ap.json before starting!"

# ── Config directory ─────────────────────────────────────────────────────────
mkdir -p "${CONFIG_DIR}"
mkdir -p /etc/dnsmasq.d
mkdir -p /var/www/piap-captive

# ── Disable default dnsmasq service (we manage it ourselves) ─────────────────
systemctl disable dnsmasq 2>/dev/null || true
# Keep hostapd disabled by default; our scripts start it as needed
systemctl disable hostapd 2>/dev/null || true
systemctl unmask hostapd 2>/dev/null || true

# Disable the default dnsmasq config so it doesn't conflict
if [[ -f /etc/dnsmasq.conf ]]; then
  cp /etc/dnsmasq.conf /etc/dnsmasq.conf.bak
  # Keep base config but disable global options that conflict
  grep -v '^interface=' /etc/dnsmasq.conf.bak > /etc/dnsmasq.conf || true
fi

# ── hostapd default config ────────────────────────────────────────────────────
if [[ -f /etc/default/hostapd ]]; then
  sed -i "s|^#*DAEMON_CONF=.*|DAEMON_CONF=\"${CONFIG_DIR}/hostapd.conf\"|" /etc/default/hostapd
fi

# ── Make scripts executable ───────────────────────────────────────────────────
log "Setting script permissions…"
chmod 750 "${INSTALL_DIR}/scripts"/*.sh
chown root:piap "${INSTALL_DIR}/scripts"/*.sh

# ── Permissions ──────────────────────────────────────────────────────────────
chown -R piap:piap "${INSTALL_DIR}"
chmod 700 "${DATA_DIR}"
chmod 600 "${DATA_DIR}"/*.json

# ── Sudoers ───────────────────────────────────────────────────────────────────
log "Installing sudoers rules…"
sed "s|/opt/piap|${INSTALL_DIR}|g" "${INSTALL_DIR}/scripts/sudoers-piap" > /etc/sudoers.d/piap
chmod 440 /etc/sudoers.d/piap
visudo -c -f /etc/sudoers.d/piap || die "sudoers file is invalid!"

# ── nftables — enable and ensure base ruleset persists ───────────────────────
log "Configuring nftables…"
systemctl enable nftables
systemctl start nftables

# ── systemd service (stamp real install path into the unit file) ──────────────
log "Installing systemd service…"
sed "s|/opt/piap|${INSTALL_DIR}|g" "${INSTALL_DIR}/piap.service" > /etc/systemd/system/piap.service
systemctl daemon-reload
systemctl enable piap
systemctl restart piap

# ── Check if wlan1 exists ─────────────────────────────────────────────────────
if ! ip link show wlan1 &>/dev/null; then
  warn "wlan1 not detected. The admin AP requires a second Wi-Fi adapter."
  warn "You can still use the main guest AP on wlan0, and access the UI over Ethernet."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
PI_IP="$(hostname -I | awk '{print $1}')"
log ""
log "╔══════════════════════════════════════════════════════╗"
log "║  PiAP installed successfully!                        ║"
log "║                                                      ║"
log "║  Web UI:  http://${PI_IP}:3000                       ║"
log "║                                                      ║"
log "║  Next steps:                                         ║"
log "║  1. Change admin AP password in:                     ║"
log "║     ${DATA_DIR}/admin-ap.json           ║"
log "║  2. Open the web UI and start the admin AP           ║"
log "║  3. Connect to 'PiAP-Admin' Wi-Fi (wlan1)           ║"
log "║  4. Create and start guest networks from the UI      ║"
log "╚══════════════════════════════════════════════════════╝"
