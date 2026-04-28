#!/usr/bin/env bash
# wifi-scan.sh — run iw dev scan as root for the scanner service.
# Usage: sudo wifi-scan.sh <interface>
IFACE="${1:-wlan1}"
exec iw dev "${IFACE}" scan
