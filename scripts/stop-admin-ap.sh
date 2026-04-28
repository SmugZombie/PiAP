#!/usr/bin/env bash
# stop-admin-ap.sh — stops the admin management AP on wlan1.
set -euo pipefail

IFACE="wlan1"
DNSMASQ_LINK="/etc/dnsmasq.d/piap-admin.conf"

echo "Stopping admin AP on ${IFACE}..."

systemctl stop hostapd-admin 2>/dev/null || true

rm -f "${DNSMASQ_LINK}"
systemctl reload-or-restart dnsmasq 2>/dev/null || true

nft flush table inet piap_admin 2>/dev/null || true
nft delete table inet piap_admin 2>/dev/null || true

ip addr flush dev "${IFACE}" 2>/dev/null || true
ip link set "${IFACE}" down 2>/dev/null || true

echo "OK: admin AP stopped"
