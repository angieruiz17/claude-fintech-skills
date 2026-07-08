# claude-fintech-skills

[![Validate](https://github.com/fawraw/claude-skills-fintech-ops/actions/workflows/validate.yml/badge.svg)](https://github.com/fawraw/claude-skills-fintech-ops/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/github/license/fawraw/claude-skills-fintech-ops)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/fawraw/claude-skills-fintech-ops)](https://github.com/fawraw/claude-skills-fintech-ops/releases)
![Skills](https://img.shields.io/badge/skills-25-blue)

A curated set of [Claude Code](https://claude.com/claude-code) skills extracted from a decade of running FinTech infrastructure, trading platforms, and broker-side systems in production.

Each skill is a single Markdown file with a YAML front-matter that Claude Code (and other agentic environments) can auto-discover. Drop them into your `~/.claude/commands/` (global) or `.claude/commands/` (per project) and Claude will use them whenever the context matches.

## Why this exists

Generic LLM advice on financial markets, network gear, or broker-grade infra is rarely good enough. These skills capture the things that:

- only show up in production (the third WebSocket trap, the third Wednesday rule, the BPIPE-vs-BLPAPI cost cliff)
- are obvious once you've been burned but invisible from any tutorial
- get reused across multiple projects and would be tedious to re-explain to a fresh assistant context

## Contents

### Trading (5)

| Skill | What it covers |
|---|---|
| [`financial-dates`](trading/financial-dates.md) | IMM dates, FRA tenors, forward-forward swaps, business calendar, spread combinatorics |
| [`bloomberg-data`](trading/bloomberg-data.md) | BDP / BDS / BLPAPI / BPIPE / add-in, ZAR IRS tickers, DV01 nominal conversion |
| [`imm-date-rolling`](trading/imm-date-rolling.md) | IMM convention parsing (`Sept` vs `Sep`), resolved-to-relative mapping, rotation pitfalls |
| [`zar-irs-finance`](trading/zar-irs-finance.md) | Spreads in basis points, DV01 / PV01, USD-to-ZAR nominal, ZARONIA OIS, butterflies |
| [`bloomberg-fix-mpf`](trading/bloomberg-fix-mpf.md) | FIX 5.0 SP2 contributor (Logon, Heartbeat, SetupMonitorRequest, MarketDataIncrementalRefresh), TLS mutual auth, dual-DC failover, seven recurrent pitfalls |

### Infrastructure (5)

| Skill | What it covers |
|---|---|
| [`proxmox-ct-setup`](infrastructure/proxmox-ct-setup.md) | LXC container sizing by workload, base setup, runtime install, systemd hardening |
| [`lxc-troubleshoot`](infrastructure/lxc-troubleshoot.md) | The nine recurrent LXC pitfalls and their fixes (gateway, DNS, apt sandbox, venv AppArmor, PostgreSQL, systemd-in-LXC) |
| [`ssh-ct-patches`](infrastructure/ssh-ct-patches.md) | Safe patterns for patching code on remote LXC via `ssh + pct exec` without bash eating template literals |
| [`samba-share-setup`](infrastructure/samba-share-setup.md) | Samba / CIFS share for external file ingestion (vendor add-ins, Windows workstations), AD Kerberos + local fallback auth, seven pitfalls |
| [`pve-cluster-join`](infrastructure/pve-cluster-join.md) | Join a new node to a Proxmox VE cluster: the four traps (TFA on root, SSH keys, `/etc/hosts`, SSH config) |

### Network (4)

| Skill | What it covers |
|---|---|
| [`nginx-websocket`](network/nginx-websocket.md) | The three classic WebSocket reverse-proxy traps (HTTP/2, hardcoded Connection header, default timeouts) and a tested vhost template |
| [`cisco-port-trace-device`](network/cisco-port-trace-device.md) | Identify the device behind a switch port: MAC + CDP / LLDP + ARP + DHCP |
| [`vpn-debug`](network/vpn-debug.md) | Systematic debugging of an IPsec / IKEv2 tunnel on Palo Alto (proxy-IDs, SAs, routes, security rules, IKE logs) |
| [`ssl-setup`](network/ssl-setup.md) | HTTPS setup with Let's Encrypt / self-signed / commercial, Caddy + nginx templates, expiry monitoring |

### Security (3)

| Skill | What it covers |
|---|---|
| [`auth-token-decode`](security/auth-token-decode.md) | Decode a JWT by hand (base64 + json), diagnose `aud` / `iss` / `exp` / scopes, distinguish Entra ID ID token vs access token vs Graph token |
| [`msal-entra-patterns`](security/msal-entra-patterns.md) | MSAL.js v4 + React + FastAPI patterns for Microsoft Entra ID (JWT validation server-side, role-based access, WebSocket auth) |
| [`gap-analysis-response-pattern`](security/gap-analysis-response-pattern.md) | Strategic playbook for responding to a loaded external gap analysis or audit: refuse the framing, separate the axes, require an external legal opinion |

### Monitoring (2)

| Skill | What it covers |
|---|---|
| [`prometheus-add-target`](monitoring/prometheus-add-target.md) | Add a host to Prometheus + Grafana with `node_exporter`, ICMP blackbox probe, dashboard host-count update, hot reload via SIGHUP |
| [`wazuh-agent-enroll`](monitoring/wazuh-agent-enroll.md) | Enrol a Wazuh agent with password authentication, version pinning, group assignment, six recurrent enrolment pitfalls |

### Telephony (2)

| Skill | What it covers |
|---|---|
| [`jitsi-post-upgrade`](telephony/jitsi-post-upgrade.md) | Fix the five recurring bugs that break Jitsi Meet after `apt upgrade jitsi-meet` |
| [`yealink-provisioning`](telephony/yealink-provisioning.md) | Provision Yealink phones (T87W, W70B DECT) against FreePBX / Asterisk: manual + EPM, DECT pairing, eight registration pitfalls |

### Frontend (1)

| Skill | What it covers |
|---|---|
| [`react-hooks-discipline`](frontend/react-hooks-discipline.md) | Hooks before early returns, defensive rendering for async data, stable list keys, useEffect cleanup, Map / Set state instances |

### Data (3)

| Skill | What it covers |
|---|---|
| [`kafka-integration`](data/kafka-integration.md) | Cluster shape, SCRAM-SHA-512 auth, topic naming, Python consumer / producer, audit feeds, monitoring |
| [`database-design`](data/database-design.md) | Tech choice cheat sheet, naming conventions, reference DDL for a matching platform, audit trail trigger, migration discipline |
| [`redis-integration`](data/redis-integration.md) | LXC deployment, ACL auth, key layout, versioned caching, pub-sub fan-out, webhook dedup, distributed locks, rate limits, seven pitfalls |

## How to use

### As Claude Code skills (recommended)

Pick the skills you want and copy them to your skills directory:

```bash
git clone https://github.com/angieruiz17/claude-fintech-skills.git
cp claude-fintech-skills/trading/financial-dates.md ~/.claude/commands/
cp claude-fintech-skills/network/nginx-websocket.md ~/.claude/commands/
```

Or symlink the whole directory:

```bash
ln -s "$PWD/claude-fintech-skills" ~/.claude/skills-fintech-ops
```

Claude Code (and compatible agents) read the YAML front-matter (`name`, `description`) to decide when a skill is relevant.

### As reference documentation

Every file is also readable on its own. Browse the directories above for production-grade notes on the matching topics.

## Contributing

Issues and pull requests are welcome, especially if you spot a production caveat that should be flagged in one of the skills.

Skill format:

- Markdown with YAML front-matter (`name`, `description`)
- Self-contained, no cross-skill imports
- "When to use" section near the top, so Claude can match context fast
- Code blocks tagged with their language for highlighting
- No company-specific IPs, hostnames, or credentials

## License

MIT. See [LICENSE](LICENSE).

## Author

Curated by [Farid Said](https://faridsaid.com), Head of IT at an institutional broker. Builds trading infrastructure, network and security, and FinTech tooling for over a decade.
