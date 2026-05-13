---
name: yealink-provisioning
description: "Provision Yealink IP phones (T87W desk, W70B DECT base) against FreePBX / Asterisk: manual web UI registration, DHCP option 66 + EPM auto-provisioning, DECT handset pairing, the eight recurring registration pitfalls."
---

# Yealink Phone Provisioning Against FreePBX

Configuration of Yealink IP phones to register on a FreePBX 17 / Asterisk 22 PBX. Covers the manual web-UI flow for one-off devices and the DHCP-option-66 + EPM flow for a fleet, plus the eight pitfalls that make a phone show `Registered` while the PBX sees nothing.

## Typical models

| Model | Type | Use |
|-------|------|-----|
| **T87W** | Desk phone with 4" touchscreen, Wi-Fi / Bluetooth | Individual extensions |
| **W70B** | DECT base station + handsets | Shared phones, mobile staff, helpdesk |

## Admin web UI

```
http://<phone-ip>/
admin / admin   (factory default)
```

On first access the UI forces you to set a real password. In production, an EPM-managed device gets its admin password pushed by the provisioning server, not typed by hand.

## Two provisioning approaches

### Manual via web UI

Use for 1-2 phones in a PoC, for diagnosis, or for a phone that isn't reachable from your provisioning server. Slow but transparent.

### DHCP option 66 + EPM (production)

DHCP hands the phone the URL of the provisioning server. The phone downloads its XML config at boot.

- DHCP server: option 66 = `http://<pbx-ip>:84/provisioning/` (FreePBX EPM default port)
- Phone boot: fetches `<MAC>.cfg`
- EPM injects SIP credentials, codecs, BLF keys, contact directory

EPM (End Point Manager) is a FreePBX module. The commercial Sangoma EPM is the easiest path; a free alternative is a hand-rolled XML template served by Apache.

## T87W: manual SIP registration

### 1. Find the phone's IP

Boot, take a DHCP lease.

- Phone menu: `Settings > Status > Network > IP`
- Or your DHCP server's leases

### 2. Open the admin UI

```
http://<phone-ip>/
admin / <password>
```

### 3. Account > Register

| Section          | Field             | Value                                |
|------------------|-------------------|--------------------------------------|
| Account          | Account 1         | active                               |
| Register         | Line Active       | ON                                   |
| Register         | Label             | display on the phone (e.g. user name)|
| Register         | Display Name      | outbound caller ID                   |
| Register         | Register Name     | extension number (e.g. `1001`)       |
| Register         | Username          | same as Register Name                |
| Register         | Password          | the extension's SIP secret           |
| SIP Server 1     | Server Host       | `<pbx-ip>`                           |
| SIP Server 1     | Port              | `5060`                               |
| SIP Server 1     | Transport         | `UDP`                                |
| SIP Server 1     | Server Expires    | `3600`                               |
| SIP Server 1     | Server Retry Counts | `3`                                |
| Outbound Proxy   | Enable            | OFF (on LAN)                         |
| NAT              | NAT               | Disabled (internal LAN)              |

Confirm. Status should flip to **Registered** (green).

### 4. Codec preference (LAN)

`Account > Codec`. For internal LAN, prefer G.711 (`PCMU` / `PCMA`): zero transcoding load on the PBX, lowest latency. Skip Opus / G.729 on LAN; they only earn their keep over WAN.

## W70B DECT: pair handsets

### Architecture

```
W70B base (one IP, e.g. 10.0.11.103)
  -- Handset 1 -> SIP Account 1 (e.g. ext 4100)
  -- Handset 2 -> SIP Account 2 (e.g. ext 4150)
  -- ... up to 8 handsets / 8 accounts
```

### Pair a handset

`Status > Handset & VoIP` (or `Account > Handset & DECT`).

1. Handset menu: `Register Handset > on base?`
2. On the base: long-press (~5 s) the button on the front to enter pairing mode
3. Web UI -> `Status > Handset List`: handset appears with its `IPUI`
4. Assign a SIP account to the new handset via `Account > Number Assignment`

### Configure SIP Account 1

`Account > Register`

| Field            | Value                |
|------------------|----------------------|
| Account 1 Active | ON                   |
| Label            | (e.g. `Helpdesk`)    |
| Display Name     | (same)               |
| Register Name    | `<extension>`        |
| Username         | `<extension>`        |
| Password         | SIP secret           |
| Server Host      | `<pbx-ip>`           |
| Port             | `5060`               |
| Transport        | UDP                  |
| Server Expires   | `3600`               |

### Number assignment

`Account > Number Assignment` decides which handset uses which SIP account for inbound and outbound calls.

| Handset    | Outgoing  | Incoming  |
|------------|-----------|-----------|
| Handset 1  | Account 1 | Account 1 |
| Handset 2  | Account 2 | Account 2 |
| ...        | ...       | ...       |

## Verify from the PBX

```bash
sudo /usr/sbin/asterisk -rx "pjsip show contacts" | grep -E '/sip:'
```

Expected:

```
1001/sip:1001@<phone-ip>:5060   <hash>   Avail   <RTT_ms>
```

If the phone says `Registered` but the PBX shows nothing, the phone is in a stale local state: power-cycle to force a fresh REGISTER.

## The eight pitfalls

### 1. "Register Failed"

1. Verify `Server Host` and `Port` match the PBX
2. Verify `Username` == extension and `Password` == SIP secret exactly (case-sensitive)
3. Verify the extension exists on the PBX: `pjsip show endpoint <ext>`
4. `tcpdump` on the PBX side to see whether REGISTER messages arrive:

```bash
sudo tcpdump -i eth0 -n "host <phone-ip> and port 5060"
```

### 2. UI says `Registered`, PBX disagrees

Stale local state. Full power-cycle (unplug, replug): soft reboot from the menu isn't always enough.

### 3. ICMP unreachable on UDP 5060 after a `fwconsole reload`

`fwconsole reload` sometimes leaves UDP 5060 unbound. Symptom: tcpdump shows the kernel replying `udp port 5060 unreachable` to the phone's REGISTER.

Fix: `sudo fwconsole restart` on the PBX.

### 4. Phone source port is 5060, not ephemeral

Yealink uses source port 5060 for SIP (standard for IP phones). Normal but surprising on a packet capture.

### 5. PJSIP `unidentified_request` rate limit

After 5 unidentified REGISTERs in 5 seconds, PJSIP silently mutes the source for 30 seconds. An aggressive retry with a wrong password trips this.

Fix: wait 30 s, or `sudo fwconsole restart`. Provide the right credentials before retrying.

### 6. Phone behind NAT (home office)

- PBX side: enable `nat=force_rport,comedia` in Asterisk SIP settings
- Phone side: `Network > NAT`: either enable STUN, or configure static NAT with the public IP and mapped port
- Firewall: forward UDP 5060 + the RTP range to the PBX

On a flat LAN with private IPs, leave NAT disabled.

### 7. DECT handset lost pairing

If a handset disappears from `Handset List`, repeat the pairing procedure (long-press the base button + handset menu).

### 8. Firmware mismatch

`Status > Version`. Upgrade via `Settings > Upgrade`: download the `.rom` from the Yealink portal, upload through the web UI. Stable enterprise firmwares are usually three to five major versions behind the latest available.

## EPM auto-provisioning (production)

End Point Manager flow:

1. DHCP option 66 = `http://<pbx-ip>:84/provisioning/`
2. Phone boots, downloads `<MAC>.cfg`
3. EPM injects:
   - SIP server, port, transport
   - All eight accounts on a DECT base, with their secrets
   - Codec list
   - BLF keys for monitoring extensions
   - Contact directory from the PBX

The Sangoma commercial EPM module supports Yealink, Polycom, Sangoma, Cisco SPA, Grandstream, Snom, and Aastra phones.

For a self-built provisioner: serve a per-MAC XML file from Apache or nginx, generated from a template. The Yealink documentation describes the XML schema per model line.

## When this skill applies

- Onboarding a new IP phone (desk or DECT) to FreePBX / Asterisk
- Phone shows `Register Failed` despite an apparently correct config
- Phone shows `Registered` but the PBX doesn't see it
- Deploying a fleet via DHCP option 66
- Pairing new DECT handsets to an existing base
