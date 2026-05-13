---
name: samba-share-setup
description: "Stand up a Samba (CIFS) share on a Linux host for external file ingestion (vendor add-ins, Windows workstations writing data). Covers AD Kerberos auth, local fallback auth, multi-client write conventions, and the seven pitfalls that break SMB in production."
---

# Samba / CIFS Share for File Ingestion

A generic procedure to set up a Samba share on a Linux host (LXC container, VM, bare metal) so that a Windows workstation or an Excel add-in can write files that a back-end service then ingests.

Typical use cases: vendor Excel add-in dropping snapshots, traders writing FX rates from a workbook, a Windows-only data provider whose output you want to capture without a manual copy.

## When to use

- A vendor or workstation only knows how to write to a UNC path
- You can't deploy a real API client on the producer side
- You want auth that piggybacks on the existing AD domain (no extra passwords)
- You need predictable file ownership on the Linux side for a watcher service

## Authentication choice: AD Kerberos vs local

**Default: AD Kerberos.** Users authenticate with their domain account (Kerberos ticket). Zero passwords to rotate, single sign-on for domain-joined machines, audit trail under the user's identity.

**Local fallback** (one Samba user + password). Only when the producer is **not** in your AD domain (standalone Linux machine, third-party SaaS that drops files).

## Option A: AD Kerberos (recommended)

### Install Samba + winbind + Kerberos

```bash
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  samba smbclient winbind libpam-winbind libnss-winbind krb5-user
systemctl enable smbd nmbd winbind
```

### Create a local group for `force group`

Files created by AD users will inherit this Linux group, which your back-end watcher then reads.

```bash
FORCE_GROUP="appwriter"           # adapt
SHARE_DIR="/srv/<share-name>"     # adapt
useradd -r -s /usr/sbin/nologin -d /nonexistent "${FORCE_GROUP}"
mkdir -p "${SHARE_DIR}"
chown "root:${FORCE_GROUP}" "${SHARE_DIR}"
chmod 2775 "${SHARE_DIR}"   # setgid: new files inherit the group
```

### `/etc/krb5.conf`

```ini
[libdefaults]
    default_realm    = <DOMAIN.LOCAL>
    dns_lookup_realm = false
    dns_lookup_kdc   = false

[realms]
    <DOMAIN.LOCAL> = {
        kdc            = <dc1-ip>
        kdc            = <dc2-ip>
        admin_server   = <dc1-ip>
        default_domain = <domain.local>
    }

[domain_realm]
    .<domain.local> = <DOMAIN.LOCAL>
    <domain.local>  = <DOMAIN.LOCAL>
```

### `/etc/samba/smb.conf` (AD member)

```ini
[global]
    workgroup = <NETBIOS_DOMAIN>
    realm     = <DOMAIN.LOCAL>
    security  = ADS

    winbind use default domain = yes
    winbind enum users  = no
    winbind enum groups = yes
    winbind refresh tickets = yes
    idmap config * : backend = tdb
    idmap config * : range   = 10000-99999
    idmap config <NETBIOS_DOMAIN> : backend = rid
    idmap config <NETBIOS_DOMAIN> : range   = 100000-999999

    server min protocol = SMB2_10
    client min protocol = SMB2_10
    log file            = /var/log/samba/log.%m
    max log size        = 1000

    load printers = no
    printing      = bsd
    printcap name = /dev/null

[<share-name>]
    path        = /srv/<share-name>
    valid users = @<NETBIOS_DOMAIN>\<AD_GROUP>
    browseable  = yes
    writable    = yes
    create mask         = 0664
    force create mode   = 0664
    directory mask      = 2775
    force directory mode = 2775
    force group         = appwriter
    store dos attributes = yes
    map acl inherit     = yes
    inherit permissions = yes
```

### `nsswitch` for winbind

```bash
sed -i 's/^passwd:.*/passwd:         files winbind/' /etc/nsswitch.conf
sed -i 's/^group:.*/group:          files winbind/'  /etc/nsswitch.conf
```

### Create the AD security group (on a DC, PowerShell)

```powershell
New-ADGroup -Name "<AD_GROUP>" -GroupScope Global -GroupCategory Security `
  -Path "OU=Applications,OU=Security,OU=Groups,DC=<domain>,DC=local" `
  -Description "Write access to <share-name>"

Add-ADGroupMember -Identity "<AD_GROUP>" -Members "user1","user2"
```

### Join the domain

Requires an account with `Add computer to domain` rights on AD.

```bash
sudo net ads join -U <admin-user>
sudo systemctl restart smbd nmbd winbind
```

### Verify

```bash
wbinfo -t                            # trust check
wbinfo -g | grep -i <ad_group>       # group resolves
testparm -s | head -30               # config valid
```

### Test from Windows

```cmd
klist purge
dir \\<host>\<share-name>
```

`klist purge` is **mandatory** after adding the user to the AD group; see pitfall 1 below.

## Option B: local auth (no AD)

### Install Samba

```bash
DEBIAN_FRONTEND=noninteractive apt-get install -y samba smbclient
systemctl enable smbd nmbd
```

### Create the Samba user (one local Unix user, one Samba password)

```bash
SHARE_USER="appwriter"
SHARE_DIR="/srv/<share-name>"
useradd -r -s /usr/sbin/nologin -d /nonexistent "${SHARE_USER}"
mkdir -p "${SHARE_DIR}"
chown "${SHARE_USER}:${SHARE_USER}" "${SHARE_DIR}"
chmod 775 "${SHARE_DIR}"

# Non-interactive Samba password (avoid TTY prompt)
PASSWORD="<strong-pw-here>"
(echo "$PASSWORD"; echo "$PASSWORD") | smbpasswd -s -a "${SHARE_USER}"
```

### `/etc/samba/smb.conf`

```ini
[global]
    workgroup     = WORKGROUP
    security      = user
    map to guest  = never
    log file      = /var/log/samba/log.%m
    max log size  = 1000

[<share-name>]
    path        = /srv/<share-name>
    valid users = <SHARE_USER>
    browseable  = yes
    writable    = yes
    create mask    = 0664
    directory mask = 0775
    force user  = <SHARE_USER>
    force group = <SHARE_USER>
```

### Validate + restart

```bash
testparm -s
systemctl restart smbd nmbd
systemctl is-active smbd nmbd
```

### Smoke test from the host itself

```bash
smbclient -U "<SHARE_USER>%<PASSWORD>" //127.0.0.1/<share-name> -c 'ls'
```

## The seven pitfalls

### 1. `klist purge` after adding to an AD group (critical)

`gpupdate /force` refreshes GPOs but **not** the Kerberos TGT. The TGT carries the group SIDs at login time. After adding a user to a new AD group:

- From the Windows client: `klist purge` (or full logout / login)
- Without it: `Access denied` even though the user is in the group

### 2. `smbpasswd` blocks on stdin

```bash
(echo "$PASSWORD"; echo "$PASSWORD") | smbpasswd -s -a "${SHARE_USER}"
```

The double-echo is the confirmation prompt; `-s` is silent.

### 3. `force user` for predictable file ownership

Without `force user`, files created by multiple Windows clients get different UIDs depending on the client. Your back-end watcher then can't read them consistently. `force user` pins ownership to a single Unix account.

### 4. `create mask = 0664`, not `0644`

The group must have write access so other processes in the same group (a Python watcher running as a different user, a separate service) can edit or delete the files.

### 5. Container-level firewall blocks SMB

On LXC with the per-interface firewall enabled, open `445/tcp` (and `139/tcp` if you need NetBIOS). Same applies to `ufw` or `nftables` on a regular host.

### 6. SMB1 vs SMB2/3

Samba ships SMB2 by default. Don't enable SMB1 (`server min protocol = NT1`) unless you have a genuine legacy client (XP, Server 2003). SMB1 is in the WannaCry/CVE-2017-0144 family.

### 7. Logs are silent at the default level

`log level = 1` in `smb.conf` shows almost nothing. Bump to `log level = 3` (or `log level = 1 auth:2` to keep noise down but get auth detail), restart `smbd`, look at `/var/log/samba/log.<machine>`.

## Security checklist

- Samba user is **not** an SSH user
- Password is 16+ chars, special chars, unique, stored in a password manager
- `valid users` explicitly lists allowed accounts; **no** `guest ok = yes`
- No internet exposure: firewall keeps `445/139` on the LAN
- SMB3 encryption: enabled by default on Samba 4.x; force with `smb encrypt = required` if needed
- Disable printing services (`load printers = no`, `disable spoolss = yes`)

## Back-end ingestion pattern

The share is the entry point; the actual work happens in a watcher service that polls the directory and pushes to a downstream system.

```python
# /opt/<app>/watcher.py
import time, hashlib, pathlib
from datetime import datetime

WATCH_DIR = pathlib.Path("/srv/<share-name>")
SEEN: dict[pathlib.Path, tuple[float, str]] = {}

def poll_once():
    for path in WATCH_DIR.iterdir():
        if not path.is_file():
            continue
        mtime = path.stat().st_mtime
        h = hashlib.sha256(path.read_bytes()).hexdigest()
        prev = SEEN.get(path)
        if prev and prev == (mtime, h):
            continue
        push_downstream(path)         # your ingestion logic
        SEEN[path] = (mtime, h)

while True:
    try:
        poll_once()
    except Exception as e:
        print(f"{datetime.utcnow().isoformat()} ERR {e}")
    time.sleep(2)
```

Key points: track `(mtime, hash)` not just `mtime` (some clients rewrite the file with the same mtime), `Restart=always` in the systemd unit, log all pushes (success and failure).

## When this skill applies

- New vendor or workstation needs a UNC drop point
- Existing share has bad file ownership (back-end can't read written files)
- AD users can read but get `Access denied` on write
- After moving an existing share to a new host
- Setting up a Linux-side ingestion pipeline for Windows-only data sources
