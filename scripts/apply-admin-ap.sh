#!/usr/bin/env bash
# apply-admin-ap.sh — starts the always-on admin management AP.
# Invoked via: sudo apply-admin-ap.sh <admin-ap-json-file>
# Must run as root.
set -euo pipefail

CONFIG_DIR="/etc/piap"
HOSTAPD_ADMIN_CONF="${CONFIG_DIR}/hostapd-admin.conf"
DNSMASQ_ADMIN_CONF="${CONFIG_DIR}/dnsmasq-admin.conf"
DNSMASQ_CONFD="/etc/dnsmasq.d"

die() { echo "ERROR: $*" >&2; exit 1; }

PROFILE_FILE="${1:-}"
[[ -n "${PROFILE_FILE}" && -f "${PROFILE_FILE}" ]] || die "Usage: $0 <admin-ap-json-file>"

PIAP_ADMIN_AP="$(cat "${PROFILE_FILE}")"
rm -f "${PROFILE_FILE}"

_str()  { python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('$1',''))" <<< "${PIAP_ADMIN_AP}"; }
_int()  { python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(int(d.get('$1',1)))" <<< "${PIAP_ADMIN_AP}"; }

IFACE="$(_str interface)"
SSID="$(_str ssid)"
PASSWORD="$(_str password)"
GATEWAY="$(_str gateway)"
DHCP_START="$(_str dhcpStart)"
DHCP_END="$(_str dhcpEnd)"
CHANNEL="$(_int channel)"

[[ -n "$IFACE" && -n "$SSID" && -n "$PASSWORD" && -n "$GATEWAY" ]] || die "Missing required admin AP fields"

HOSTAPD_ADMIN_PID="/run/piap-hostapd-admin.pid"
DNSMASQ_ADMIN_PID="/run/piap-dnsmasq-${IFACE}.pid"
HOSTAPD_ADMIN_LOG="/var/log/piap-hostapd-admin.log"
DNSMASQ_ADMIN_LOG="/var/log/piap-dnsmasq-${IFACE}.log"

mkdir -p "${CONFIG_DIR}"

# ── Stop any existing admin AP processes ──────────────────────────────────────
if [[ -f "${HOSTAPD_ADMIN_PID}" ]]; then
  kill "$(cat "${HOSTAPD_ADMIN_PID}")" 2>/dev/null || true
  sleep 0.5
  rm -f "${HOSTAPD_ADMIN_PID}"
fi
if [[ -f "${DNSMASQ_ADMIN_PID}" ]]; then
  kill "$(cat "${DNSMASQ_ADMIN_PID}")" 2>/dev/null || true
  rm -f "${DNSMASQ_ADMIN_PID}"
fi
pkill -f "hostapd.*hostapd-admin.conf" 2>/dev/null || true
pkill -f "dnsmasq.*dnsmasq-admin.conf" 2>/dev/null || true
sleep 0.5

# ── Release interface from wpa_supplicant and NetworkManager ──────────────────
systemctl stop wpa_supplicant 2>/dev/null || true
systemctl stop "wpa_supplicant@${IFACE}" 2>/dev/null || true
wpa_cli -i "${IFACE}" terminate 2>/dev/null || true
pkill -f "wpa_supplicant.*${IFACE}" 2>/dev/null || true
# Tell NetworkManager to stop managing this interface (if NM is running)
nmcli dev set "${IFACE}" managed no 2>/dev/null || true
rfkill unblock wifi 2>/dev/null || true
sleep 1

# ── hostapd config ────────────────────────────────────────────────────────────
cat > "${HOSTAPD_ADMIN_CONF}" << HEOF
interface=${IFACE}
driver=nl80211
ssid=${SSID}
hw_mode=g
channel=${CHANNEL}
ieee80211n=1
wmm_enabled=1
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=${PASSWORD}
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
HEOF

# ── dnsmasq config ────────────────────────────────────────────────────────────
{
  printf "interface=%s\n"             "${IFACE}"
  printf "bind-interfaces\n"
  printf "dhcp-range=%s,%s,255.255.255.0,12h\n" "${DHCP_START}" "${DHCP_END}"
  printf "dhcp-option=3,%s\n"        "${GATEWAY}"
  printf "dhcp-option=6,%s\n"        "${GATEWAY}"
  printf "no-resolv\n"
  printf "server=8.8.8.8\n"
  printf "server=8.8.4.4\n"
} > "${DNSMASQ_ADMIN_CONF}"

ln -sf "${DNSMASQ_ADMIN_CONF}" "${DNSMASQ_CONFD}/piap-admin.conf"

# ── nftables ──────────────────────────────────────────────────────────────────
NFT_ADMIN="${CONFIG_DIR}/piap-admin.nft"

python3 - "${IFACE}" "${NFT_ADMIN}" << 'PYEOF'
import sys
iface, out = sys.argv[1], sys.argv[2]
L = []
L.append('table inet piap_admin {')
L.append('  chain input {')
L.append('    type filter hook input priority filter; policy accept;')
L.append('    iifname "' + iface + '" udp dport 67 accept')
L.append('    iifname "' + iface + '" udp dport 53 accept')
L.append('    iifname "' + iface + '" tcp dport 53 accept')
L.append('    iifname "' + iface + '" tcp dport 3000 accept')
L.append('    iifname "' + iface + '" tcp dport 80 accept')
L.append('    iifname "' + iface + '" tcp dport 22 accept')
L.append('  }')
L.append('  chain forward_admin {')
L.append('    type filter hook forward priority filter; policy accept;')
L.append('    iifname "' + iface + '" oifname "wlan0" drop')
L.append('    iifname "wlan0" oifname "' + iface + '" drop')
L.append('  }')
L.append('  chain postrouting_admin {')
L.append('    type nat hook postrouting priority srcnat;')
L.append('    iifname "' + iface + '" oifname "eth0" masquerade')
L.append('  }')
L.append('}')
open(out, 'w').write('\n'.join(L) + '\n')
PYEOF

nft flush table inet piap_admin 2>/dev/null || true
nft -f "${NFT_ADMIN}"

sysctl -w net.ipv4.ip_forward=1 > /dev/null

# ── Pre-create log files world-readable so piap service can read them ─────────
touch "${HOSTAPD_ADMIN_LOG}" "${DNSMASQ_ADMIN_LOG}"
chmod 644 "${HOSTAPD_ADMIN_LOG}" "${DNSMASQ_ADMIN_LOG}"

# ── Reset interface mode so hostapd gets a clean managed→AP transition ────────
# Killing the old hostapd leaves the interface in AP mode in the kernel;
# drivers reject a second SET_INTERFACE AP→AP call. Reset to managed first.
ip link set "${IFACE}" down 2>/dev/null || true
iw dev "${IFACE}" set type managed 2>/dev/null || true
sleep 1
ip link set "${IFACE}" up
ip addr flush dev "${IFACE}"
sleep 0.5

# ── Start hostapd directly ────────────────────────────────────────────────────
hostapd -B -P "${HOSTAPD_ADMIN_PID}" -f "${HOSTAPD_ADMIN_LOG}" "${HOSTAPD_ADMIN_CONF}" \
  || { echo "ERROR: hostapd failed, check ${HOSTAPD_ADMIN_LOG}" >&2; exit 1; }

sleep 1

# ── Assign IP ─────────────────────────────────────────────────────────────────
ip addr flush dev "${IFACE}"
ip addr add "${GATEWAY}/24" dev "${IFACE}"

# ── Start dnsmasq directly (not via systemd) ──────────────────────────────────
dnsmasq \
  --conf-file="${DNSMASQ_ADMIN_CONF}" \
  --pid-file="${DNSMASQ_ADMIN_PID}" \
  --log-facility="${DNSMASQ_ADMIN_LOG}" \
  || { echo "ERROR: dnsmasq failed for admin AP" >&2; exit 1; }

echo "OK: admin AP '${SSID}' started on ${IFACE}"
