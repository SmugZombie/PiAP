#!/usr/bin/env bash
# stop-ap.sh — tears down the guest AP cleanly.
# Invoked via: sudo stop-ap.sh
# Must run as root.
set -euo pipefail

IFACE="wlan0"
DNSMASQ_LINK="/etc/dnsmasq.d/piap-guest.conf"

echo "Stopping guest AP on ${IFACE}..."

systemctl stop hostapd 2>/dev/null || true
systemctl stop dnsmasq 2>/dev/null || true

# Remove our dnsmasq symlink
rm -f "${DNSMASQ_LINK}"

# Flush nftables guest table
nft flush table inet piap_guest 2>/dev/null || true
nft delete table inet piap_guest 2>/dev/null || true

# Remove IP from interface; bring it down
ip addr flush dev "${IFACE}" 2>/dev/null || true
ip link set "${IFACE}" down 2>/dev/null || true

# Disable IP forwarding
sysctl -w net.ipv4.ip_forward=0 > /dev/null

echo "OK: guest AP stopped"
