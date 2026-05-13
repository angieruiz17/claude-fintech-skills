# claude-skills-fintech-ops

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

### Infrastructure (3)

| Skill | What it covers |
|---|---|
| [`proxmox-ct-setup`](infrastructure/proxmox-ct-setup.md) | LXC container sizing by workload, base setup, runtime install, systemd hardening |
| [`lxc-troubleshoot`](infrastructure/lxc-troubleshoot.md) | The nine recurrent LXC pitfalls and their fixes (gateway, DNS, apt sandbox, venv AppArmor, PostgreSQL, systemd-in-LXC) |
| [`ssh-ct-patches`](infrastructure/ssh-ct-patches.md) | Safe patterns for patching code on remote LXC via `ssh + pct exec` without bash eating template literals |

### Network (3)

| Skill | What it covers |
|---|---|
| [`nginx-websocket`](network/nginx-websocket.md) | The three classic WebSocket reverse-proxy traps (HTTP/2, hardcoded Connection header, default timeouts) and a tested vhost template |
| [`cisco-port-trace-device`](network/cisco-port-trace-device.md) | Identify the device behind a switch port -- MAC + CDP / LLDP + ARP + DHCP |
| [`vpn-debug`](network/vpn-debug.md) | Systematic debugging of an IPsec / IKEv2 tunnel on Palo Alto (proxy-IDs, SAs, routes, security rules, IKE logs) |

### Frontend (1)

| Skill | What it covers |
|---|---|
| [`react-hooks-discipline`](frontend/react-hooks-discipline.md) | Hooks before early returns, defensive rendering for async data, stable list keys, useEffect cleanup, Map / Set state instances |

### Data (2)

| Skill | What it covers |
|---|---|
| [`kafka-integration`](data/kafka-integration.md) | Cluster shape, SCRAM-SHA-512 auth, topic naming, Python consumer / producer, audit feeds, monitoring |
| [`database-design`](data/database-design.md) | Tech choice cheat sheet, naming conventions, reference DDL for a matching platform, audit trail trigger, migration discipline |

## How to use

### As Claude Code skills (recommended)

Pick the skills you want and copy them to your skills directory:

```bash
git clone https://github.com/fawraw/claude-skills-fintech-ops.git
cp claude-skills-fintech-ops/trading/financial-dates.md ~/.claude/commands/
cp claude-skills-fintech-ops/network/nginx-websocket.md ~/.claude/commands/
```

Or symlink the whole directory:

```bash
ln -s "$PWD/claude-skills-fintech-ops" ~/.claude/skills-fintech-ops
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
