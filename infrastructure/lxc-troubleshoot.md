---
name: lxc-troubleshoot
description: Diagnose and fix the nine recurrent pitfalls when running LXC containers on Proxmox VE (gateway, DNS, apt sandbox, venv apparmor, PostgreSQL initdb, file permissions, systemd in LXC).
---

# LXC Troubleshooting on Proxmox

Production-tested checklist for the recurrent issues when running LXC on Proxmox VE. Walk these in order; most CT problems are one of the nine entries below.

## 1. Wrong gateway

**Symptom**: ping inside the VLAN works, anything outside times out, DNS fails.

**Diagnose**: compare the CT's `gw` setting with a known-good neighbour.

```bash
pct config <good-ctid>    | grep gw
pct config <broken-ctid>  | grep gw
```

**Fix**:

```bash
pct set <ctid> --net0 "name=eth0,bridge=vmbr0,gw=<correct-gw>,ip=<ip>/<prefix>,type=veth"
pct exec <ctid> -- ip route replace default via <correct-gw> dev eth0
```

## 2. DNS doesn't resolve

**Symptom**: `nslookup` hangs, `apt-get update` returns `Temporary failure resolving`.

**Common causes**:

- Wrong nameserver set on the CT config
- `/etc/resolv.conf` is overwritten by PVE on every boot, so editing inside the CT is not enough

**Diagnose + fix**:

```bash
pct exec <ctid> -- cat /etc/resolv.conf
pct exec <ctid> -- nslookup deb.debian.org <ns-ip>

# Set persistently at the CT config level, then reboot the CT
pct set <ctid> --nameserver "<ns1> <ns2>"
pct stop <ctid> && sleep 2 && pct start <ctid>
```

## 3. `apt-get` fails, `wget` works

**Symptom**: `wget` reaches mirrors fine, but `apt-get update` reports `Temporary failure resolving`.

**Cause**: apt drops privileges to the `_apt` user; in some LXC configurations that user has no network access.

**Fix** (permanent):

```bash
pct exec <ctid> -- bash -c \
  'echo "APT::Sandbox::User \"root\";" > /etc/apt/apt.conf.d/99sandbox-fix'
```

On networks where IPv6 is enabled but not routable, add `Acquire::ForceIPv4 "true";` to the same file.

## 4. `Permission denied` on `venv/bin/python` or `uvicorn`

**Symptom**: systemd reports `Failed at step EXEC spawning .../venv/bin/python: Permission denied`.

**Cause**: in privileged LXC, AppArmor restricts execution of binaries in non-standard paths.

**Two fixes**:

```bash
# Fix A: install at the system level instead of venv
pct exec <ctid> -- pip3 install --break-system-packages <packages>
# Systemd unit:
ExecStart=/usr/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

```bash
# Fix B: unconfine AppArmor on this CT (use sparingly)
echo 'lxc.apparmor.profile: unconfined' | tee -a /etc/pve/lxc/<ctid>.conf
pct stop <ctid> && pct start <ctid>
```

Fix A is preferred for security. Use Fix B when you have multiple binaries in custom paths.

## 5. PostgreSQL `initdb: could not look up effective user ID`

**Symptom**: `initdb: could not look up effective user ID 103: Permission denied`.

**Cause**: `/proc` is namespace-restricted in unprivileged LXC; `getpwuid()` fails for the postgres user.

**Fix**: enable nesting and keyctl, plus unconfined AppArmor:

```bash
pct set <ctid> --features nesting=1,keyctl=1
echo 'lxc.apparmor.profile: unconfined' | tee -a /etc/pve/lxc/<ctid>.conf
pct stop <ctid> && pct start <ctid>
pct exec <ctid> -- pg_createcluster 15 main --start
```

If it still fails, fall back to SQLite for the MVP and migrate to PostgreSQL on a different node or in a VM.

## 6. `bash: /etc/bash.bashrc: Permission denied`

**Symptom**: every SSH login prints the error before the prompt appears.

**Fix**:

```bash
pct exec <ctid> -- chmod 644 /etc/bash.bashrc
```

## 7. Perl warnings on `psql`, `createuser`, etc.

**Symptom**: `Can't locate warnings.pm: /etc/perl/warnings.pm: Permission denied`.

**Fix**:

```bash
pct exec <ctid> -- chmod -R a+rX /etc/perl/ /usr/share/perl/ /usr/lib/perl/
```

## 8. `localhost` doesn't resolve (`127.0.0.1`)

**Symptom**: `could not translate host name "localhost" to address`.

**Cause**: `/etc/hosts` is empty or missing the loopback entry inside the CT.

**Fix**:

```bash
pct exec <ctid> -- bash -c \
  'grep -q "127.0.0.1.*localhost" /etc/hosts || echo "127.0.0.1 localhost" >> /etc/hosts'
```

## 9. systemd services stuck in `activating` or `failed`

**Symptom**: services never reach `active`; logs mention cgroup or namespace permission errors.

**Cause**: systemd inside LXC has limited access to cgroups and namespaces.

**fail2ban**:

```bash
pct exec <ctid> -- bash -c '
mkdir -p /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/sshd.conf <<EOF
[sshd]
enabled = true
backend = systemd
EOF
systemctl restart fail2ban'
```

**systemd-logind** (SSH 25-second delay symptom):

```bash
pct exec <ctid> -- bash -c '
mkdir -p /etc/systemd/system/systemd-logind.service.d
cat > /etc/systemd/system/systemd-logind.service.d/lxc-override.conf <<EOF
[Service]
ProtectProc=
ProtectHostname=
PrivateDevices=
ProtectKernelTunables=
ProtectKernelModules=
ProtectControlGroups=
MemoryDenyWriteExecute=
EOF
systemctl daemon-reload
systemctl restart systemd-logind'
```

## CT creation template that avoids most of the above

```bash
pct create <ctid> local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst \
  --hostname     <hostname> \
  --cores        4 \
  --memory       4096 \
  --swap         512 \
  --rootfs       <storage>:32 \
  --net0         "name=eth0,bridge=vmbr0,gw=<gw>,ip=<ip>/<prefix>,type=veth" \
  --nameserver   "<ns1> <ns2>" \
  --searchdomain <domain> \
  --unprivileged 0 \
  --features     nesting=1,keyctl=1 \
  --start        1 \
  --onboot       1

echo 'lxc.apparmor.profile: unconfined' | tee -a /etc/pve/lxc/<ctid>.conf

# Apply the hygiene fixes up-front
pct exec <ctid> -- bash -c '
  echo "APT::Sandbox::User \"root\";" > /etc/apt/apt.conf.d/99sandbox-fix
  chmod 644 /etc/bash.bashrc
  chmod -R a+rX /etc/perl/ /usr/share/perl/ /usr/lib/perl/
  grep -q "127.0.0.1.*localhost" /etc/hosts || echo "127.0.0.1 localhost" >> /etc/hosts
'
```

Privileged CT (`--unprivileged 0`) is convenient for tooling-heavy workloads, but explicitly weigh the security trade-off before keeping it in production. The default should be unprivileged unless you have a concrete reason.
