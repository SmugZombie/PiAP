# PiAP — Raspberry Pi Isolated Wi-Fi Access Point Manager

A self-hosted web application for creating and managing isolated ("dead-end") Wi-Fi networks on a Raspberry Pi. Designed for **authorized lab, test, and guest network use only**.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Raspberry Pi                     │
│                                                  │
│  ┌──────────┐     ┌───────────┐                  │
│  │  wlan0   │     │  wlan1    │                  │
│  │ Guest AP │     │ Admin AP  │                  │
│  │(isolated)│     │(mgmt UI)  │                  │
│  └────┬─────┘     └─────┬─────┘                  │
│       │                 │                         │
│  nftables DROP     full access                    │
│  (all forward)     to port 3000                   │
│       │                 │                         │
│  ┌────▼─────────────────▼──────────────────┐     │
│  │          PiAP Node.js App (port 3000)   │     │
│  │  hostapd · dnsmasq · nftables control   │     │
│  └─────────────────────────────────────────┘     │
│                        │                         │
│                       eth0 → LAN/Internet         │
└─────────────────────────────────────────────────┘
```

### Two Wi-Fi interfaces

| Interface | Purpose | Internet? |
|-----------|---------|-----------|
| `wlan0`   | Guest / lab networks (managed via UI) | Configurable (OFF by default) |
| `wlan1`   | Admin management AP — always-on, gives wireless access to the UI | Yes (via eth0 NAT) |

You can use PiAP with just `wlan0` (accessed over Ethernet), but a second USB Wi-Fi adapter on `wlan1` enables wireless management.

---

## Hardware Requirements

- Raspberry Pi 3B+ / 4 / 5 (any model with built-in Wi-Fi for `wlan0`)
- Optional: USB Wi-Fi adapter for `wlan1` (admin AP)
- Ethernet connection (`eth0`) for internet uplink
- Raspberry Pi OS Bookworm or Bullseye (64-bit recommended)

---

## Installation

```bash
git clone https://github.com/yourrepo/piap.git
cd piap
sudo bash install.sh
```

The installer:
1. Installs `hostapd`, `dnsmasq`, `nftables`, Node.js 20+
2. Creates a `piap` system user with minimal sudo rights
3. Installs the app to `/opt/piap`
4. Configures and starts the `piap` systemd service
5. Sets restrictive file permissions

### After installation

1. **Change the admin AP password** before starting it:
   ```bash
   sudo nano /opt/piap/data/admin-ap.json
   ```
   Set a strong password for `"password"`.

2. **Open the web UI** at `http://<pi-ip>:3000` (over Ethernet initially).

3. Go to the **Admin AP** tab → click **Start Admin AP**.

4. Connect your laptop/phone to `PiAP-Admin` Wi-Fi.

5. Access the UI wirelessly at `http://192.168.200.1:3000`.

---

## Usage

### Creating a guest network

1. Click **Networks** → **+ New Profile**
2. Enter SSID and password
3. Optionally configure subnet, captive portal message, internet/LAN access
4. Click **Save Profile**
5. Click **Start** on the profile card

### Stopping a network

Click **Stop** on the active profile card. nftables rules are flushed and the interfaces are cleaned up.

### Viewing clients

Click the **Clients** tab. Shows live DHCP leases from `/var/lib/misc/dnsmasq.leases`.

### Viewing logs

Click the **Logs** tab. Shows recent `journalctl` output for `hostapd`, `dnsmasq`, and `piap`.

---

## API Reference

All endpoints return JSON.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/profiles` | List all profiles |
| `POST` | `/api/profiles` | Create a profile |
| `GET` | `/api/profiles/:id` | Get a profile |
| `PATCH` | `/api/profiles/:id` | Update a profile (must be stopped) |
| `DELETE` | `/api/profiles/:id` | Delete a profile (must be stopped) |
| `POST` | `/api/profiles/:id/start` | Start a network |
| `POST` | `/api/profiles/:id/stop` | Stop a network |
| `GET` | `/api/clients` | DHCP leases + system status |
| `GET` | `/api/logs?lines=100` | Journal logs for all services |
| `GET` | `/api/admin-ap` | Admin AP settings |
| `PATCH` | `/api/admin-ap` | Update admin AP settings |
| `POST` | `/api/admin-ap/start` | Start admin AP |
| `POST` | `/api/admin-ap/stop` | Stop admin AP |

### Profile object

```json
{
  "id": "uuid",
  "ssid": "Deadend-Test",
  "password": "StrongPass123!",
  "subnet": "10.55.0.0/24",
  "gateway": "10.55.0.1",
  "dhcpStart": "10.55.0.50",
  "dhcpEnd": "10.55.0.200",
  "channel": 6,
  "internetAccess": false,
  "lanAccess": false,
  "captivePortal": true,
  "captiveMessage": "This is a test/lab network.",
  "active": false
}
```

---

## Firewall Model (nftables)

### Guest network — isolation (default)

```
table inet piap_guest {
  chain input {
    # Allow from wlan0: DHCP, DNS, HTTP (captive), app port
    # DROP everything else
  }
  chain forward {
    policy drop;          ← blocks ALL forwarding by default
    # wlan0 → eth0 only allowed if internetAccess=true or lanAccess=true
  }
}
```

### Admin AP

```
table inet piap_admin {
  chain forward_admin {
    # BLOCK: wlan1 ↔ wlan0 (admin cannot reach guest clients)
    # ALLOW: wlan1 → eth0 (admin has internet)
  }
}
```

---

## File Structure

```
piap/
├── server/
│   ├── app.js                   # Express entry point
│   ├── routes/
│   │   ├── profiles.js          # Network profile CRUD + start/stop
│   │   ├── clients.js           # DHCP lease viewer
│   │   ├── logs.js              # journalctl log fetcher
│   │   └── adminAp.js           # Admin AP management
│   └── services/
│       ├── profileService.js    # Profile storage + validation
│       ├── networkService.js    # Shell script invocation
│       ├── dhcpService.js       # Lease file parser
│       ├── logService.js        # journalctl wrapper
│       └── adminApService.js    # Admin AP settings + control
├── scripts/
│   ├── apply-profile.sh         # Configure + start guest AP
│   ├── stop-ap.sh               # Stop guest AP + flush rules
│   ├── apply-admin-ap.sh        # Configure + start admin AP
│   ├── stop-admin-ap.sh         # Stop admin AP
│   └── sudoers-piap             # Minimal sudo rules for piap user
├── public/
│   └── index.html               # Single-file Bootstrap UI
├── captive/
│   └── index.html               # Captive portal page
├── data/
│   ├── profiles.json            # Saved network profiles
│   └── admin-ap.json            # Admin AP config
├── piap.service                 # systemd unit
├── install.sh                   # Full installer
└── package.json
```

---

## Security Notes

### What this system does
- Creates clearly labeled, isolated Wi-Fi networks for **authorized** lab/test/guest use
- Blocks all forwarding by default (dead-end network)
- Runs as an unprivileged `piap` user with scoped sudo rights only for specific scripts
- Sanitizes all input before passing to shell scripts (JSON via env var, never interpolated)
- Profiles include internet/LAN access toggles — both OFF by default

### What this system does NOT do
- No credential harvesting
- No impersonation of real networks
- No deception or evil twin functionality
- No open networks (WPA2 required; minimum 8-char password enforced)

### Hardening recommendations
1. **Run behind a firewall** — do not expose port 3000 to the internet
2. **Add authentication** to the web UI (nginx basic auth, or a simple token middleware) if the Pi is accessible to untrusted devices
3. **Use HTTPS** — add an nginx reverse proxy with a self-signed or Let's Encrypt cert
4. **Change the admin AP password** immediately after installation
5. The `piap` user's sudo rights are scoped to exact script paths — verify `/etc/sudoers.d/piap` after installation

### Example: add basic auth via nginx

```nginx
server {
    listen 80;
    location / {
        auth_basic "PiAP";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:3000;
    }
}
```

---

## Troubleshooting

**hostapd fails to start**
```bash
sudo journalctl -u hostapd -n 50
# Check: correct interface name (wlan0), driver (nl80211), no conflicting process
```

**dnsmasq fails / DHCP not working**
```bash
sudo journalctl -u dnsmasq -n 50
# Check: no duplicate interface bindings in /etc/dnsmasq.d/
```

**nftables rules not applied**
```bash
sudo nft list ruleset
sudo nft -f /etc/piap/piap-guest.nft
```

**App not starting**
```bash
sudo systemctl status piap
sudo journalctl -u piap -n 50
```

**Cannot reach UI over admin AP (wlan1)**
- Check wlan1 is detected: `ip link show wlan1`
- Check admin AP is running: `sudo systemctl status hostapd-admin`
- Connect to `PiAP-Admin` SSID, navigate to `http://192.168.200.1:3000`

---

## License

MIT — for authorized use in controlled environments only. The authors accept no responsibility for misuse.
