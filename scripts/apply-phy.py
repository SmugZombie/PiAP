#!/usr/bin/env python3
"""apply-phy.py — configure a physical Wi-Fi radio with one or more SSIDs.

Called by apply-phy.sh (via sudo). Reads config from the temp file at
sys.argv[1], deletes it immediately, then:
  - If profiles list is non-empty: sets up multi-BSS AP + dnsmasq + nftables
  - If profiles list is empty: tears everything down for that phy
"""
import sys
import json
import os
import signal
import subprocess
import time
import ipaddress


def run(*args, check=True):
    """Run a command; on failure raise RuntimeError that includes stderr."""
    result = subprocess.run(list(args), capture_output=True, text=True)
    if check and result.returncode != 0:
        cmd = ' '.join(str(a) for a in args)
        raise RuntimeError(
            f'Command failed (exit {result.returncode}): {cmd}\n'
            f'stdout: {result.stdout.strip()}\n'
            f'stderr: {result.stderr.strip()}'
        )
    return result


def silent(*args):
    subprocess.run(list(args), capture_output=True)


def stop_pid(pid_file):
    if not os.path.exists(pid_file):
        return
    try:
        pid = int(open(pid_file).read().strip())
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)
    except (ValueError, ProcessLookupError, PermissionError):
        pass
    try:
        os.unlink(pid_file)
    except FileNotFoundError:
        pass


def get_ifaces_on_phy(phy):
    """Return all interface names that belong to this physical radio."""
    result = subprocess.run(['iw', 'dev'], capture_output=True, text=True)
    ifaces = []
    cur_phy = None
    for line in result.stdout.split('\n'):
        stripped = line.strip()
        if stripped.startswith('phy#'):
            cur_phy = 'phy' + stripped[4:].split()[0]
        elif cur_phy == phy and stripped.startswith('Interface '):
            ifaces.append(stripped.split()[1])
    return ifaces


def kill_wpa_supplicant(iface):
    """Stop wpa_supplicant for a specific interface (all known launch styles)."""
    silent('systemctl', 'stop', 'wpa_supplicant')
    silent('systemctl', 'stop', f'wpa_supplicant@{iface}')
    silent('wpa_cli', '-i', iface, 'terminate')
    silent('pkill', '-f', f'wpa_supplicant.*{iface}')
    silent('pkill', '-f', f'wpa_supplicant.*-i.*{iface}')
    time.sleep(1)


def teardown_phy(phy, config_dir, dnsmasq_d):
    """Stop hostapd, all dnsmasq instances, remove virtual ifaces, flush nft."""
    hostapd_pid  = f'/run/piap-hostapd-{phy}.pid'
    hostapd_conf = f'{config_dir}/hostapd-{phy}.conf'

    stop_pid(hostapd_pid)
    silent('pkill', '-f', f'hostapd.*hostapd-{phy}.conf')
    time.sleep(0.5)

    for iface in get_ifaces_on_phy(phy):
        stop_pid(f'/run/piap-dnsmasq-{iface}.pid')
        silent('pkill', '-f', f'dnsmasq.*dnsmasq-{iface}.conf')
        silent('nft', 'flush', 'table', 'inet', f'piap_{iface}')
        silent('nft', 'delete', 'table', 'inet', f'piap_{iface}')
        link = f'{dnsmasq_d}/piap-{iface}.conf'
        if os.path.lexists(link):
            os.remove(link)
        # Remove virtual interfaces we created (primary stays)
        if iface.startswith('piap'):
            silent('ip', 'link', 'set', iface, 'down')
            silent('iw', 'dev', iface, 'del')


def start_hostapd(hostapd_conf, hostapd_pid, phy):
    """Start hostapd, logging to file. Raise with log tail on failure."""
    log_file = f'/var/log/piap-hostapd-{phy}.log'
    # Pre-create world-readable so the piap service user can read it later
    open(log_file, 'a').close()
    os.chmod(log_file, 0o644)
    result = subprocess.run(
        ['hostapd', '-B', '-P', hostapd_pid, '-f', log_file, hostapd_conf],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        tail = ''
        try:
            tail = open(log_file).read()[-3000:]
        except Exception:
            pass
        # Surface Broadcom multi-BSS limitation as a clear message
        if 'Failed to create interface' in tail or 'Device or resource busy' in tail:
            raise RuntimeError(
                'This Wi-Fi adapter does not support multiple SSIDs (multi-BSS). '
                'Use a separate physical adapter for each network.'
            )
        raise RuntimeError(
            f'hostapd failed (exit {result.returncode}):\n'
            f'{result.stderr.strip()}\n'
            f'--- hostapd log ---\n{tail}'
        )


def wait_for_iface(iface, timeout=8):
    """Block until 'ip link show <iface>' succeeds or timeout elapses."""
    for _ in range(timeout):
        r = subprocess.run(['ip', 'link', 'show', iface], capture_output=True)
        if r.returncode == 0:
            return True
        time.sleep(1)
    return False


def main():
    config_file = sys.argv[1]
    with open(config_file) as f:
        config = json.load(f)
    os.unlink(config_file)

    phy           = config['phy']
    primary_iface = config['primaryIface']
    profiles      = config['profiles']

    config_dir   = '/etc/piap'
    dnsmasq_d    = '/etc/dnsmasq.d'
    hostapd_conf = f'{config_dir}/hostapd-{phy}.conf'
    hostapd_pid  = f'/run/piap-hostapd-{phy}.pid'
    nft_file     = f'{config_dir}/piap-{phy}.nft'

    os.makedirs(config_dir, exist_ok=True)

    # Always tear down existing state for this phy first
    teardown_phy(phy, config_dir, dnsmasq_d)

    if not profiles:
        silent('sysctl', '-w', 'net.ipv4.ip_forward=0')
        print(f'OK: {phy} stopped, no active profiles')
        return

    # All BSSes on same radio share the primary profile's channel
    channel = int(profiles[0].get('channel', 6))

    # ── Release the interface from wpa_supplicant ─────────────────────────────
    kill_wpa_supplicant(primary_iface)
    silent('rfkill', 'unblock', 'wifi')

    # Bring primary interface down so hostapd can take full control
    silent('ip', 'link', 'set', primary_iface, 'down')
    silent('ip', 'addr', 'flush', 'dev', primary_iface)
    time.sleep(0.5)

    # ── hostapd multi-BSS config ──────────────────────────────────────────────
    lines = []
    for i, profile in enumerate(profiles):
        iface = profile['logicalIface']
        ssid  = profile['ssid']
        pw    = profile['password']

        if i == 0:
            lines += [
                f'interface={iface}',
                'driver=nl80211',
                f'ssid={ssid}',
                'hw_mode=g',
                f'channel={channel}',
                'ieee80211n=1',
                'wmm_enabled=1',
                'macaddr_acl=0',
                'auth_algs=1',
                'ignore_broadcast_ssid=0',
                'wpa=2',
                f'wpa_passphrase={pw}',
                'wpa_key_mgmt=WPA-PSK',
                'rsn_pairwise=CCMP',
            ]
        else:
            # hostapd creates the bss= virtual interface itself on start
            lines += [
                '',
                f'bss={iface}',
                f'ssid={ssid}',
                'macaddr_acl=0',
                'auth_algs=1',
                'ignore_broadcast_ssid=0',
                'wpa=2',
                f'wpa_passphrase={pw}',
                'wpa_key_mgmt=WPA-PSK',
                'rsn_pairwise=CCMP',
            ]

    with open(hostapd_conf, 'w') as f:
        f.write('\n'.join(lines) + '\n')

    # ── Start hostapd (brings up the interface and any bss= virtuals) ─────────
    start_hostapd(hostapd_conf, hostapd_pid, phy)

    # Wait for primary interface to be available, then assign IP
    if not wait_for_iface(primary_iface):
        raise RuntimeError(f'{primary_iface} did not come up after hostapd start')

    gw0     = profiles[0]['gateway']
    subnet0 = profiles[0]['subnet']
    prefix0 = subnet0.split('/')[-1]
    silent('ip', 'addr', 'flush', 'dev', primary_iface)
    run('ip', 'addr', 'add', f'{gw0}/{prefix0}', 'dev', primary_iface)

    # Assign IPs to virtual BSS interfaces (created by hostapd)
    for profile in profiles[1:]:
        iface  = profile['logicalIface']
        gw     = profile['gateway']
        subnet = profile['subnet']
        prefix = subnet.split('/')[-1]
        if wait_for_iface(iface, timeout=8):
            silent('ip', 'addr', 'flush', 'dev', iface)
            run('ip', 'addr', 'add', f'{gw}/{prefix}', 'dev', iface)
            run('ip', 'link', 'set', iface, 'up')
        else:
            print(f'WARNING: {iface} did not appear — BSS may not be fully supported',
                  file=sys.stderr)

    # ── Per-interface dnsmasq configs and nftables rules ─────────────────────
    nft_lines    = []
    needs_forward = False

    for profile in profiles:
        iface      = profile['logicalIface']
        gw         = profile['gateway']
        subnet     = profile['subnet']
        net        = ipaddress.IPv4Network(subnet, strict=False)
        netmask    = str(net.netmask)
        dhcp_start = profile['dhcpStart']
        dhcp_end   = profile['dhcpEnd']
        captive    = profile.get('captivePortal', True)
        internet   = profile.get('internetAccess', False)
        lan_access = profile.get('lanAccess', False)

        if internet or lan_access:
            needs_forward = True

        # dnsmasq config
        dm_lines = [
            f'interface={iface}',
            'bind-interfaces',
            f'dhcp-range={dhcp_start},{dhcp_end},{netmask},12h',
            f'dhcp-option=3,{gw}',
            f'dhcp-option=6,{gw}',
            'no-resolv',
            'log-queries',
            'log-dhcp',
        ]
        if captive:
            dm_lines.append(f'address=/#/{gw}')
        else:
            dm_lines += ['server=8.8.8.8', 'server=8.8.4.4']

        dm_conf = f'{config_dir}/dnsmasq-{iface}.conf'
        with open(dm_conf, 'w') as f:
            f.write('\n'.join(dm_lines) + '\n')

        link = f'{dnsmasq_d}/piap-{iface}.conf'
        if os.path.lexists(link):
            os.remove(link)
        os.symlink(dm_conf, link)

        # nft — separate table per interface
        table = f'piap_{iface}'
        nft_lines.append(f'table inet {table} {{')
        nft_lines.append('  chain input {')
        nft_lines.append('    type filter hook input priority filter; policy accept;')
        nft_lines.append(f'    iifname "{iface}" udp dport 67 accept')
        nft_lines.append(f'    iifname "{iface}" udp dport 53 accept')
        nft_lines.append(f'    iifname "{iface}" tcp dport 53 accept')
        nft_lines.append(f'    iifname "{iface}" tcp dport 80 accept')
        nft_lines.append(f'    iifname "{iface}" tcp dport 3000 accept')
        nft_lines.append(f'    iifname "{iface}" drop')
        nft_lines.append('  }')
        nft_lines.append('  chain forward {')
        nft_lines.append('    type filter hook forward priority filter; policy drop;')
        if internet:
            nft_lines.append(f'    iifname "{iface}" oifname "eth0" ct state new accept')
            nft_lines.append('    ct state established,related accept')
        elif lan_access:
            nft_lines.append(f'    iifname "{iface}" oifname "eth0" accept')
            nft_lines.append('    ct state established,related accept')
        nft_lines.append(f'    iifname "{iface}" drop')
        nft_lines.append('  }')
        if internet or lan_access:
            nft_lines.append('  chain postrouting {')
            nft_lines.append('    type nat hook postrouting priority srcnat;')
            nft_lines.append(f'    iifname "{iface}" oifname "eth0" masquerade')
            nft_lines.append('  }')
        nft_lines.append('}')

    with open(nft_file, 'w') as f:
        f.write('\n'.join(nft_lines) + '\n')

    run('nft', '-f', nft_file)

    val = '1' if needs_forward else '0'
    silent('sysctl', '-w', f'net.ipv4.ip_forward={val}')

    # ── Start one dnsmasq per logical interface ───────────────────────────────
    for profile in profiles:
        iface    = profile['logicalIface']
        dm_conf  = f'{config_dir}/dnsmasq-{iface}.conf'
        pid_file = f'/run/piap-dnsmasq-{iface}.pid'
        log_file = f'/var/log/piap-dnsmasq-{iface}.log'
        open(log_file, 'a').close()
        os.chmod(log_file, 0o644)
        run('dnsmasq',
            f'--conf-file={dm_conf}',
            f'--pid-file={pid_file}',
            f'--log-facility={log_file}')

    print(f'OK: {len(profiles)} network(s) running on {phy}')


if __name__ == '__main__':
    main()
