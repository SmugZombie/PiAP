#!/usr/bin/env bash
# apply-phy.sh — configure a physical Wi-Fi radio with one or more SSIDs.
# Usage: sudo apply-phy.sh <config-json-file>
# The JSON file is deleted immediately after reading (contains passwords).
# Must run as root.
set -euo pipefail

CONFIG_FILE="${1:-}"
[[ -n "${CONFIG_FILE}" && -f "${CONFIG_FILE}" ]] || { echo "ERROR: Usage: $0 <config-json-file>" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "${SCRIPT_DIR}/apply-phy.py" "${CONFIG_FILE}"
