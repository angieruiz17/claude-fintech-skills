# Changelog

All notable changes to this project are documented here. Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-13

Three new skill categories and ten new skills, taking the total from 14 to 24 across 8 categories.

### Added

- **Security category** (3 skills):
  - `auth-token-decode`: decode a JWT by hand with base64 + json, identify ID / access / Graph tokens
  - `msal-entra-patterns`: MSAL.js v4 + React + FastAPI, JWT validation server-side, role-based access, WebSocket auth
  - `gap-analysis-response-pattern`: strategic playbook for responding to loaded external audits
- **Monitoring category** (2 skills):
  - `prometheus-add-target`: add a host with `node_exporter` + ICMP blackbox + hot reload via SIGHUP
  - `wazuh-agent-enroll`: agent enrolment with version pinning and the six recurring pitfalls
- **Telephony category** (2 skills):
  - `jitsi-post-upgrade`: the five recurring bugs after `apt upgrade jitsi-meet`
  - `yealink-provisioning`: T87W desk and W70B DECT provisioning against FreePBX, eight pitfalls
- **Infrastructure** (2 additional skills):
  - `samba-share-setup`: CIFS share for external file ingestion (AD Kerberos + local auth)
  - `pve-cluster-join`: join a Proxmox VE node, the four traps blocking `pvecm add`
- **Network** (1 additional skill):
  - `ssl-setup`: HTTPS with Let's Encrypt / self-signed / commercial, Caddy + nginx templates

## [0.1.0] - 2026-05-13

Initial public release. 14 Claude Code skills curated from a decade of FinTech production.

### Added

- **Trading** (5): `financial-dates`, `bloomberg-data`, `imm-date-rolling`, `zar-irs-finance`, `bloomberg-fix-mpf`
- **Infrastructure** (3): `proxmox-ct-setup`, `lxc-troubleshoot`, `ssh-ct-patches`
- **Network** (3): `nginx-websocket`, `cisco-port-trace-device`, `vpn-debug`
- **Frontend** (1): `react-hooks-discipline`
- **Data** (2): `kafka-integration`, `database-design`
- MIT license
- GitHub Actions `validate` workflow: YAML front-matter validation + markdownlint

[Unreleased]: https://github.com/fawraw/claude-skills-fintech-ops/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/fawraw/claude-skills-fintech-ops/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fawraw/claude-skills-fintech-ops/releases/tag/v0.1.0
