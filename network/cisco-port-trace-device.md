---
name: cisco-port-trace-device
description: Identify what device is plugged into a Cisco switch port -- MAC + CDP/LLDP + ARP + DHCP. Handles IP phones, DECT bases, workstations, printers, and dead ports.
---

# Trace a Device Behind a Cisco Port

How to identify the device sitting behind a given switch port, going from the physical port down to a confident "this is X, IP Y". Useful for change reviews, audits, IP phone troubleshooting, and the recurrent "which user is on port 42 again?".

## When to use

- Need to verify what's behind a port before changing its config
- Locating an unknown device causing CDP / spanning-tree noise
- Tracing the IP of an IP phone, DECT base, AP, printer, or workstation
- Building or refreshing your port-to-device inventory
- Investigating an err-disable or a port-security violation

## The five-step trace

### 1. Connect to the switch

For Cisco IOS / IOS-XE, in read-only via the right SSH options:

```bash
expect -c '
set timeout 15
spawn ssh \
  -o KexAlgorithms=+diffie-hellman-group14-sha1 \
  -o HostKeyAlgorithms=+ssh-rsa \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  <user>@<switch>
expect "*assword:" { send "<password>\r" }
expect "#"
send "terminal length 0\r"
expect "#"
'
```

Old 3750X-class boxes also need `-o Ciphers=+aes256-cbc`. For NX-OS, drop the legacy algorithm flags.

### 2. Port state

```
show interfaces <port> status
show running-config interface <port>
```

What you want to see: description, access / voice VLAN, status (`connected` vs `notconnect` vs `err-disabled`), negotiated speed / duplex.

### 3. MAC table -- the MAC behind the port

```
show mac address-table interface <port>
```

Typical output:

```
Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
  11    44db.d2f0.de6a    STATIC      Gi2/0/20
 111    aa11.bb22.cc33    DYNAMIC     Gi2/0/20
```

If you see **two MACs in two VLANs**, you almost certainly have an IP phone with a PC daisy-chained behind it (one MAC on the voice VLAN, one on the data VLAN).

### 4. CDP and LLDP

```
show cdp neighbors <port> detail
show lldp neighbors <port> detail
```

Typical CDP detail from a Yealink T87W IP phone:

```
Device ID:      T87WC4FC221DE4C9
Entry address:  10.0.11.102
Platform:       T87W
Capabilities:   Host Phone
Port ID:        WAN PORT
Holdtime:       126 sec
Version:        185.87.0.15
Power drawn:    8.4 W
```

What typically announces itself:

| Device class                    | Announces via |
|---------------------------------|---------------|
| Yealink T87W / T87X / W70B      | CDP           |
| Cisco IP phones (legacy)        | CDP           |
| UniFi access points             | LLDP-MED      |
| Modern printers (HP, etc.)      | LLDP          |
| Workstations (Windows, macOS)   | usually neither |
| IPC trading turrets             | sometimes LLDP, often nothing |
| Servers (Linux, ESXi, Hyper-V)  | depends on agent config |

### 5. ARP lookup when CDP / LLDP is silent

If the device announces nothing, take the MAC from step 3 and resolve it via ARP on whichever device hosts the SVI for that VLAN. Depending on your topology that may be:

- the switch itself (if it has L3 SVIs for the VLAN)
- the upstream router / firewall (Palo Alto, Cisco core, Nexus)
- a separate L3 box

```
show ip arp | include <mac-substring>
```

If the device runs DHCP, the lease database is another reliable lookup (server-side `Get-DhcpServerv4Lease` on Windows, `dhcp-lease-list` on Kea, `journalctl -u dnsmasq` on small setups).

## Single-session trace via expect

For audits, run all the commands in a single `expect` session:

```bash
expect -c "
set timeout 20
spawn ssh -o KexAlgorithms=+diffie-hellman-group14-sha1 -o HostKeyAlgorithms=+ssh-rsa \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null <user>@<switch>
expect \"*assword:\" { send \"<password>\r\" }
expect \"#\"
send \"terminal length 0\r\"          ; expect \"#\"
send \"show interfaces <port> status\r\" ; expect \"#\"
send \"show running-config interface <port>\r\" ; expect \"#\"
send \"show mac address-table interface <port>\r\" ; expect \"#\"
send \"show cdp neighbors <port> detail\r\" ; expect \"#\"
send \"show lldp neighbors <port> detail\r\" ; expect \"#\"
send \"exit\r\"
expect eof
"
```

## Typical patterns

### IP phone with daisy-chained workstation

```
Status:    connected   access VLAN 111   voice VLAN 11   a-full a-1000
MAC table: 2 MACs (one in VLAN 11, one in VLAN 111)
CDP:       Yealink T87W / Cisco / Polycom
ARP/DHCP:  voice MAC -> phone IP, data MAC -> workstation IP
```

### DECT base

```
Status:    connected   VLAN 11   a-half a-10
MAC table: single MAC in voice VLAN
CDP:       Yealink W70B / similar
```

The `a-half / a-10` autoneg is normal for DECT bases.

### Workstation only

```
Status:    connected   VLAN 111   a-full a-1000
MAC table: single dynamic MAC
CDP / LLDP: nothing
Resolution: ARP -> IP -> DHCP lease hostname -> directory
```

### Empty port

```
Status:    notconnect
MAC table: empty
CDP / LLDP: empty
```

Cable unplugged, peer powered off, or upstream port disabled.

### err-disable

```
Status:    err-disabled
```

Common causes:

- BPDU guard triggered (typical with IP phones that bridge through an internal switch)
- Port-security violation (a learned MAC was replaced)
- Storm-control threshold exceeded

```
show errdisable recovery
show interfaces <port> | include error
```

## Pitfalls

| Pitfall                          | What you see                          | What to check                            |
|----------------------------------|---------------------------------------|------------------------------------------|
| MAC in two VLANs                 | Ambiguous device identity             | IP phone with PC behind: voice + data    |
| CDP empty                        | Connected but anonymous               | Try LLDP, fall back to ARP / DHCP        |
| Both empty                       | Pure silent device                    | ARP -> DHCP lease -> reverse DNS         |
| `a-half / a-10`                  | Degraded autoneg                      | Bad cable, forced peer config, or DECT   |
| MAC in `STATIC` type             | Sticky port-security                  | `show port-security interface <port>`    |
| ARP empty on the switch          | No SVI here for the VLAN              | Query the L3 device for that subnet      |
| Multiple MACs on one VLAN        | Unmanaged hub or unauthorised daisy   | Check port-security, BPDU guard          |

## Related skills

- [`cisco-audit`](#) -- full read-only audit of a switch
- `cisco-port-config-clone` -- clone or modify port config after a trace
- Vendor inventory of switches and their SSH quirks
