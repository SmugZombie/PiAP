#!/usr/bin/env bash
# apply-profile.sh — reads PIAP_PROFILE (JSON via env), configures and starts guest AP.
# Invoked via: sudo apply-profile.sh
# Must run as root.
set -euo pipefail

IFACE="wlan0"
CONFIG_DIR="/etc/piap"
HOSTAPD_CONF="${CONFIG_DIR}/hostapd.conf"
DNSMASQ_CONF="${CONFIG_DIR}/dnsmasq-guest.conf"
HOSTAPD_DEFAULT="/etc/default/hostapd"
DNSMASQ_CONFD="/etc/dnsmasq.d"
NFT_RULES="${CONFIG_DIR}/piap-guest.nft"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTIVE_SRC="${SCRIPT_DIR}/../captive/index.html"
CAPTIVE_HTML="/var/www/piap-captive/index.html"

die() { echo "ERROR: $*" >&2; exit 1; }

PROFILE_FILE="${1:-}"
[[ -n "${PROFILE_FILE}" && -f "${PROFILE_FILE}" ]] || die "Usage: $0 <profile-json-file>"

# Read JSON from the temp file, then delete it immediately so the password
# doesn't linger on disk. Root can read it because root can read any file.
PIAP_PROFILE="$(cat "${PROFILE_FILE}")"
rm -f "${PROFILE_FILE}"

# Parse JSON with python3 — arguments pass field names, stdout is the value
_str()  { python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('$1',''))"           <<< "${PIAP_PROFILE}"; }
_bool() { python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('true' if d.get('$1') else 'false')" <<< "${PIAP_PROFILE}"; }
_int()  { python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(int(d.get('$1',6)))"      <<< "${PIAP_PROFILE}"; }

SSID="$(_str ssid)"
PASSWORD="$(_str password)"
GATEWAY="$(_str gateway)"
SUBNET="$(_str subnet)"
DHCP_START="$(_str dhcpStart)"
DHCP_END="$(_str dhcpEnd)"
CHANNEL="$(_int channel)"
CAPTIVE_PORTAL="$(_bool captivePortal)"
INTERNET_ACCESS="$(_bool internetAccess)"
LAN_ACCESS="$(_bool lanAccess)"
CAPTIVE_MSG="$(_str captiveMessage)"

[[ -n "$SSID" && -n "$PASSWORD" && -n "$GATEWAY" && -n "$SUBNET" ]] || die "Missing required profile fields"

PREFIX="${SUBNET##*/}"
NETMASK="$(python3 -c "import ipaddress; print(str(ipaddress.IPv4Network('${SUBNET}', strict=False).netmask))")"

mkdir -p "${CONFIG_DIR}"

# ── hostapd config ────────────────────────────────────────────────────────────
cat > "${HOSTAPD_CONF}" << HEOF
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

# Point hostapd at our config
sed -i "s|^#*DAEMON_CONF=.*|DAEMON_CONF=\"${HOSTAPD_CONF}\"|" "${HOSTAPD_DEFAULT}"

# ── Assign IP to interface ────────────────────────────────────────────────────
ip link set "${IFACE}" up
ip addr flush dev "${IFACE}"
ip addr add "${GATEWAY}/${PREFIX}" dev "${IFACE}"

# ── dnsmasq config ────────────────────────────────────────────────────────────
{
  printf "interface=%s\n"             "${IFACE}"
  printf "bind-interfaces\n"
  printf "dhcp-range=%s,%s,%s,12h\n" "${DHCP_START}" "${DHCP_END}" "${NETMASK}"
  printf "dhcp-option=3,%s\n"        "${GATEWAY}"
  printf "dhcp-option=6,%s\n"        "${GATEWAY}"
  printf "no-resolv\n"
  printf "log-queries\n"
  printf "log-dhcp\n"

  if [[ "${CAPTIVE_PORTAL}" == "true" ]]; then
    printf "address=/#/%s\n" "${GATEWAY}"
  else
    printf "server=8.8.8.8\n"
    printf "server=8.8.4.4\n"
  fi
} > "${DNSMASQ_CONF}"

ln -sf "${DNSMASQ_CONF}" "${DNSMASQ_CONFD}/piap-guest.conf"

# ── Captive portal HTML ───────────────────────────────────────────────────────
if [[ "${CAPTIVE_PORTAL}" == "true" && -f "${CAPTIVE_SRC}" ]]; then
  mkdir -p "$(dirname "${CAPTIVE_HTML}")"
  cp "${CAPTIVE_SRC}" "${CAPTIVE_HTML}"
  if [[ -n "${CAPTIVE_MSG}" ]]; then
    python3 - "${CAPTIVE_HTML}" "${CAPTIVE_MSG}" << 'PYEOF'
import sys
path, msg = sys.argv[1], sys.argv[2]
data = open(path).read().replace('__CAPTIVE_MESSAGE__', msg)
open(path, 'w').write(data)
PYEOF
  fi
fi

# ── nftables isolation rules ──────────────────────────────────────────────────
# Build the ruleset line-by-line to avoid f-string brace-escaping pitfalls.
python3 - "${IFACE}" "${INTERNET_ACCESS}" "${LAN_ACCESS}" "${NFT_RULES}" << 'PYEOF'
import sys

iface      = sys.argv[1]
internet   = sys.argv[2] == 'true'
lan        = sys.argv[3] == 'true'
out        = sys.argv[4]

L = []
L.append('table inet piap_guest {')

# input chain — allow only DHCP, DNS, captive portal, and app port from guest iface
L.append('  chain input {')
L.append('    type filter hook input priority 0; policy accept;')
L.append('    iifname "' + iface + '" udp dport 67 accept')
L.append('    iifname "' + iface + '" udp dport 53 accept')
L.append('    iifname "' + iface + '" tcp dport 53 accept')
L.append('    iifname "' + iface + '" tcp dport 80 accept')
L.append('    iifname "' + iface + '" tcp dport 3000 accept')
L.append('    iifname "' + iface + '" drop')
L.append('  }')
L.append('')

# forward chain — drop all by default; selectively allow if flags set
L.append('  chain forward {')
L.append('    type filter hook forward priority 0; policy drop;')
if internet:
    L.append('    iifname "' + iface + '" oifname "eth0" ct state new accept')
    L.append('    ct state established,related accept')
elif lan:
    L.append('    iifname "' + iface + '" oifname "eth0" accept')
    L.append('    ct state established,related accept')
L.append('    iifname "' + iface + '" drop')
L.append('  }')

# NAT postrouting — only needed when forwarding is allowed
if internet or lan:
    L.append('')
    L.append('  chain postrouting {')
    L.append('    type nat hook postrouting priority 100;')
    L.append('    iifname "' + iface + '" oifname "eth0" masquerade')
    L.append('  }')

L.append('}')

with open(out, 'w') as f:
    f.write('\n'.join(L) + '\n')
PYEOF

nft flush table inet piap_guest 2>/dev/null || true
nft -f "${NFT_RULES}"

# ── IP forwarding ─────────────────────────────────────────────────────────────
if [[ "${INTERNET_ACCESS}" == "true" || "${LAN_ACCESS}" == "true" ]]; then
  sysctl -w net.ipv4.ip_forward=1 > /dev/null
else
  sysctl -w net.ipv4.ip_forward=0 > /dev/null
fi

# ── Start services ────────────────────────────────────────────────────────────
systemctl stop hostapd 2>/dev/null || true
systemctl stop dnsmasq 2>/dev/null || true
sleep 1
systemctl start hostapd
systemctl start dnsmasq

echo "OK: guest AP '${SSID}' started on ${IFACE}"
