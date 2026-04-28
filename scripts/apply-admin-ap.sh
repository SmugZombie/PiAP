#!/usr/bin/env bash
# apply-admin-ap.sh — starts the always-on admin management AP on wlan1.
# Invoked via: sudo apply-admin-ap.sh (with PIAP_ADMIN_AP env var set)
# Must run as root.
set -euo pipefail

CONFIG_DIR="/etc/piap"
HOSTAPD_ADMIN_CONF="${CONFIG_DIR}/hostapd-admin.conf"
DNSMASQ_ADMIN_CONF="${CONFIG_DIR}/dnsmasq-admin.conf"
DNSMASQ_CONFD="/etc/dnsmasq.d"
SYSTEMD_DIR="/etc/systemd/system"

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

mkdir -p "${CONFIG_DIR}"

# ── hostapd-admin config ──────────────────────────────────────────────────────
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

# ── IP assignment for wlan1 ───────────────────────────────────────────────────
ip link set "${IFACE}" up
ip addr flush dev "${IFACE}"
ip addr add "${GATEWAY}/24" dev "${IFACE}"

# ── dnsmasq-admin config ──────────────────────────────────────────────────────
{
  printf "interface=%s\n"             "${IFACE}"
  printf "bind-interfaces\n"
  printf "dhcp-range=%s,%s,255.255.255.0,12h\n" "${DHCP_START}" "${DHCP_END}"
  printf "dhcp-option=3,%s\n"        "${GATEWAY}"
  printf "dhcp-option=6,%s\n"        "${GATEWAY}"
  printf "no-resolv\n"
  # Admin AP forwards DNS to upstream (admins need real DNS)
  printf "server=8.8.8.8\n"
  printf "server=8.8.4.4\n"
} > "${DNSMASQ_ADMIN_CONF}"

ln -sf "${DNSMASQ_ADMIN_CONF}" "${DNSMASQ_CONFD}/piap-admin.conf"

# ── nftables: allow admin AP full access to Pi, block cross-AP ───────────────
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

# ── hostapd-admin systemd service ────────────────────────────────────────────
cat > "${SYSTEMD_DIR}/hostapd-admin.service" << SEOF
[Unit]
Description=PiAP Admin Wi-Fi AP (wlan1)
After=network.target
Wants=network.target

[Service]
Type=forking
PIDFile=/run/hostapd-admin.pid
ExecStart=/usr/sbin/hostapd -B -P /run/hostapd-admin.pid ${HOSTAPD_ADMIN_CONF}
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target
SEOF

systemctl daemon-reload
systemctl stop hostapd-admin 2>/dev/null || true

# Restart dnsmasq to pick up new admin config
systemctl stop dnsmasq 2>/dev/null || true
systemctl start dnsmasq
systemctl start hostapd-admin

echo "OK: admin AP '${SSID}' started on ${IFACE}"
