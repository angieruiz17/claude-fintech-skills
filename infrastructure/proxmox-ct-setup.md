---
name: proxmox-ct-setup
description: "Create and configure a Proxmox LXC container dedicated to a single application: sizing by workload type, base setup, runtime install, systemd unit, monitoring onboarding."
---

# Proxmox LXC Setup for a Single Application

How to spin up an LXC container on Proxmox VE dedicated to one application, with sane defaults for sizing, base setup, runtime install, and onboarding.

## When to use

- New self-hosted service that warrants its own container (web app, API, matching engine, database, etc.)
- Splitting an existing co-tenant out of a shared container
- Standing up a PoC that needs full root access without touching VMs

For one-off tooling or short-lived experiments, `docker run` or a shared dev container is often a better fit.

## Pre-flight

1. Pick a free `VMID` (LXC and QEMU share the namespace on a cluster) and a free IP on the target subnet.
2. Decide which node hosts the CT. With shared storage, you can live-migrate later.
3. Pick a container template. Debian 12 (bookworm) minimal is a good default.

## Sizing by workload

| Workload type                        | CPU       | RAM    | Disk   | Notes                                                |
|--------------------------------------|-----------|--------|--------|------------------------------------------------------|
| Static site, light API               | 2 cores   | 1 GB   | 8 GB   | Hugo, MkDocs, simple FastAPI                         |
| API + small embedded DB              | 2 cores   | 2 GB   | 16 GB  | FastAPI + SQLite or Redis                            |
| API + PostgreSQL                     | 4 cores   | 4 GB   | 32 GB  | App + relational DB on the same CT                   |
| Real-time service (WebSocket, queue) | 4 cores   | 4 GB   | 32 GB  | Matching engine, ticker stream, in-memory order book |
| Full-stack (app + DB + cache)        | 4 cores   | 8 GB   | 50 GB  | PoC / dev environment                                |

For long-running production services, prefer **shared storage** (NFS, Ceph) so you can live-migrate. Avoid `local-lvm` if multi-node availability matters.

## Create via Proxmox API

```bash
curl -sk -X POST \
  -H "Authorization: PVEAPIToken=<user>@pve!<token-name>=<TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "vmid":      <VMID>,
    "hostname":  "<app-name>",
    "ostemplate":"local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst",
    "cores":     4,
    "memory":    4096,
    "swap":      512,
    "rootfs":    "<storage>:32",
    "net0":      "name=eth0,bridge=vmbr0,ip=<IP>/24,gw=<GW>",
    "nameserver":"<DNS>",
    "start":     1,
    "unprivileged": 1
  }' \
  https://<pve-host>:8006/api2/json/nodes/<node>/lxc
```

Unprivileged containers (`unprivileged: 1`) are the default. Drop to privileged only for workloads that legitimately need it (Docker-in-LXC, specific kernel features) and audit the security implications.

## Base setup

Over SSH (jump-host the cluster if needed):

```bash
apt update && apt upgrade -y
apt install -y curl wget git sudo htop nano unzip ca-certificates

# Dedicated low-privilege user for the app (not root)
useradd -m -s /bin/bash <app-user>
echo "<app-user> ALL=(ALL) NOPASSWD: /bin/systemctl restart <app-name>" \
  > /etc/sudoers.d/<app-user>
mkdir -p /home/<app-user>/.ssh && chmod 700 /home/<app-user>/.ssh

# Time and identity
timedatectl set-timezone <Region/City>
hostnamectl set-hostname <app-name>
```

## Runtime install patterns

**Python (FastAPI / Flask):**
```bash
apt install -y python3 python3-pip python3-venv
install -d -o <app-user> -g <app-user> /opt/<app-name>
sudo -u <app-user> python3 -m venv /opt/<app-name>/venv
sudo -u <app-user> /opt/<app-name>/venv/bin/pip install -r /opt/<app-name>/requirements.txt
```

**Node.js (React, Vite, Next.js):**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pm2
```

**PostgreSQL:**
```bash
apt install -y postgresql postgresql-client
sudo -u postgres createuser <app-name>
sudo -u postgres createdb <app-name> -O <app-name>
# Then tune /etc/postgresql/15/main/postgresql.conf for the CT's memory
```

**Redis:**
```bash
apt install -y redis-server
systemctl enable --now redis-server
# Configure bind, requirepass, maxmemory in /etc/redis/redis.conf
```

## Systemd unit

```ini
# /etc/systemd/system/<app-name>.service
[Unit]
Description=<app-name>
After=network.target

[Service]
Type=simple
User=<app-user>
Group=<app-user>
WorkingDirectory=/opt/<app-name>
ExecStart=/opt/<app-name>/venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8080
EnvironmentFile=/opt/<app-name>/.env
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/<app-name>/data

[Install]
WantedBy=multi-user.target
```

The hardening directives (`NoNewPrivileges`, `ProtectSystem`, `ProtectHome`) are cheap wins. Add `ReadWritePaths` for any writable directories your app needs.

## Onboarding the CT

Once the application runs, fold the container into your observability and backup stack:

- **Monitoring**: node_exporter, Promtail (Loki), Wazuh agent
- **Backup**: PBS for LXC-native snapshots, or `pg_dump` / app-level backups for state
- **Reverse proxy**: Caddy or nginx in front, TLS via Let's Encrypt or internal CA
- **DNS**: A record on your internal DNS (forward + reverse)
- **Documentation**: name, IP, ports, dependencies, runbook link

## Checklist

- [ ] CT created, started, reachable over SSH
- [ ] Hostname, timezone, base packages set
- [ ] Dedicated non-root user with minimal sudo
- [ ] Runtime installed (Python / Node / DB)
- [ ] Systemd unit with hardening, enabled and active
- [ ] Monitoring agents installed and reporting
- [ ] Backup configured
- [ ] Reverse proxy and DNS done
- [ ] Documentation added to the inventory
