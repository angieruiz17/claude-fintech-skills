---
name: vpn-debug
description: Systematic debugging of an IPsec / IKEv2 tunnel between two Palo Alto firewalls (proxy-IDs, SAs, routes, security rules, zones, IKE logs, forced renegotiation).
---

# IPsec Tunnel Debugging (Palo Alto)

Step-by-step playbook to diagnose a site-to-site IPsec tunnel between two Palo Alto firewalls. Most of the steps translate directly to Cisco IOS / IOS-XE if you adapt the CLI.

## When to use

- A remote site loses connectivity to the head office
- A specific subnet stops working through an otherwise healthy tunnel
- Tunnel is listed as `init` or `inactive` and never recovers
- After a Panorama push, traffic that used to flow no longer does
- New proxy-IDs added but not negotiating

## Parameters you need

- Remote site (so you know the peer IP, gateway name, expected proxy-IDs)
- Symptom (whole site down vs specific subnet vs slow vs intermittent)
- Whether either side is in **passive** mode (only one side can initiate)

## Step 1: identify the tunnel

```
set cli pager off
show vpn flow | match <site-tag>
```

Capture:
- tunnel name
- tunnel interface (`tunnel.NN`)
- peer IP
- state (`active`, `init`, `inactive`)

## Step 2: IPsec SAs

```
show vpn ipsec-sa | match <tunnel-name>
```

Each proxy-ID should appear with a non-zero SPI. A missing SA means that specific proxy-ID never negotiated -- check IKE logs for `no-proposal` or `child-fail`.

## Step 3: proxy-IDs in detail

```
show vpn flow name <tunnel-name>:<proxy-id>
```

What to verify:

| Field                  | Healthy value                                          |
|------------------------|--------------------------------------------------------|
| `state`                | `active`                                               |
| `proxy-id`             | local + remote subnets match symmetrically on both sides |
| `initiator`            | `yes` on one side (the other should be `no`)           |
| `key acquire requests` | low, stable                                            |
| `peer ip`              | the real public IP of the remote PA, not `0.0.0.0`     |

`peer ip = 0.0.0.0` means no SA negotiated yet. `key acquire requests` climbing fast with no SA = repeated negotiation failure.

## Step 4: routes

```
show routing route | match <dest-ip>
show routing route | match tunnel.<NN>
```

The route to the remote subnet must point at the right tunnel interface. After an inbound route added on Panorama, also `commit` and `push`.

## Step 5: security rules

```
show session all filter source <src> destination <dst>
```

- Sessions in `ACTIVE` but no reply -> traffic crossed the rule but isn't being encapsulated (proxy-ID issue, MTU issue, or remote drop).
- No sessions at all -> traffic blocked by an earlier security rule.

```
show config pushed-shared-policy | match <rule-name>
```

Confirms which device group / shared rule actually matched, useful when Panorama hierarchy is non-trivial.

## Step 6: zone of the tunnel interface

```
show interface tunnel.<NN>
```

The zone (`VPN`, `INTERNAL`, ...) must align with your security rules. If the tunnel interface ended up in the wrong zone after a template change, every rule referencing the previous zone will silently stop matching.

## Step 7: IKE logs

```
show log system direction equal backward | match <peer-ip>
```

Substrings worth grepping for:

| Substring         | Meaning                                              |
|-------------------|------------------------------------------------------|
| `nego-child-succ` | child SA negotiated (good)                           |
| `nego-child-st`   | child SA started (intermediate)                      |
| `child-fail`      | child SA failed -- read the next line for the reason |
| `no-proposal`     | crypto mismatch -- check encryption / hash / DH       |
| `id-mismatch`     | proxy-ID mismatch -- subnets differ across sides     |
| `ike-sa-delete`   | the peer dropped the SA -- often a config change     |
| `auth-failed`     | wrong PSK or wrong cert                              |

## Step 8: force renegotiation

If a proxy-ID is stuck in `init`:

```
test vpn ipsec-sa tunnel <tunnel>:<proxy-id>
```

Only the **initiator** side can drive this. If your side is in passive mode, force from the other end.

If that doesn't help, clear the whole IKE SA. **Warning**: this temporarily drops all child SAs on the gateway.

```
clear vpn ike-sa gateway <gateway-name>
test vpn ike-sa gateway <gateway-name>
```

## Adding a new proxy-ID to an existing tunnel

Typical change to extend a tunnel to a new subnet (e.g. monitoring host, new VLAN).

1. Add the proxy-ID on the **hub-side** template (in Panorama)
2. Add the symmetric proxy-ID on the **spoke-side** template
3. Add a `/32` (or `/24`, ...) route pointing at the tunnel interface, both sides
4. Add a security rule on the hub: source zone -> `VPN` zone
5. Add a security rule on the spoke: `VPN` zone -> local zone
6. **Commit** Panorama, then **Push to Devices** with `Include Device and Network Templates` ticked
7. Force negotiation from the initiator side: `test vpn ipsec-sa tunnel <tunnel>:<proxy-id>`

If the hub is in passive mode, step 7 has to be triggered from the spoke.

## Common pitfalls

- **Asymmetric proxy-IDs**: subnets must match exactly on both sides. A `/24` on one side and a `/23` on the other will negotiate, then drop traffic.
- **Forgetting "Include Device and Network Templates"** on the Panorama push: policies push, but template changes (including new proxy-IDs) don't. The tunnel looks correct in the GUI but won't actually negotiate.
- **Asymmetric routing**: traffic enters via the tunnel but the return path goes out a different interface -> reply dropped.
- **MTU**: GRE-in-IPsec or ESP overhead can push you past 1500. If everything looks correct but big TCP transfers stall, try `set network interface tunnel.<NN> mtu 1400`.
- **Mode passive both sides**: tunnel will never come up. Exactly one side must be the initiator.
- **PSK / cert rotation**: rotated on one side but not pushed to the other.

## When this skill applies

- Tunnel up but a specific subnet doesn't pass
- Tunnel reported as down by monitoring
- Recurring `key acquire` storms in IKE logs
- After a Panorama push, traffic broke
- New proxy-ID added but no SA appearing
