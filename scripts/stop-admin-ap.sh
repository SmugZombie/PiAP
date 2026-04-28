#!/usr/bin/env bash
# stop-admin-ap.sh — stops the admin management AP.
# Usage: sudo stop-admin-ap.sh <interface>
set -euo pipefail

IFACE="${1:-wlan1}"

HOSTAPD_ADMIN_PID="/run/piap-hostapd-admin.pid"
DNSMASQ_ADMIN_PID="/run/piap-dnsmasq-${IFACE}.pid"
DNSMASQ_LINK="/etc/dnsmasq.d/piap-admin.conf"

echo "Stopping admin AP on ${IFACE}..."

if [[ -f "${HOSTAPD_ADMIN_PID}" ]]; then
  kill "$(cat "${HOSTAPD_ADMIN_PID}")" 2>/dev/null || true
  rm -f "${HOSTAPD_ADMIN_PID}"
fi
pkill -f "hostapd.*hostapd-admin.conf" 2>/dev/null || true

if [[ -f "${DNSMASQ_ADMIN_PID}" ]]; then
  kill "$(cat "${DNSMASQ_ADMIN_PID}")" 2>/dev/null || true
  rm -f "${DNSMASQ_ADMIN_PID}"
fi
pkill -f "dnsmasq.*dnsmasq-admin.conf" 2>/dev/null || true

rm -f "${DNSMASQ_LINK}"

nft flush table inet piap_admin 2>/dev/null || true
nft delete table inet piap_admin 2>/dev/null || true

ip addr flush dev "${IFACE}" 2>/dev/null || true
ip link set "${IFACE}" down 2>/dev/null || true

echo "OK: admin AP stopped"
