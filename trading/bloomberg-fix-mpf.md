---
name: bloomberg-fix-mpf
description: Build a Bloomberg FIX-MPF (FIX 5.0 SP2) contributor in Python -- Logon, Heartbeat, SetupMonitorRequest, MarketDataIncrementalRefresh, TLS mutual auth, dual-DC failover, the seven recurrent pitfalls.
---

# Bloomberg FIX-MPF Contributor

Pattern for implementing a server-side **FIX 5.0 SP2** client against Bloomberg's "FIX-MPF" variant to publish prices on Bloomberg pages. Replaces decentralised DCAP (Excel plug-in) publication with a centralised, auditable pipeline.

## When to use

- Move price publication off traders' Excel and onto a back-end service
- Add a new asset class to an existing FIX contributor (rates, bonds, FX)
- Debug a Logon that's failing for non-obvious reasons
- Set up dual-DC redundancy (NY + NJ) for production
- Pick between `simplefix` and `quickfix-python` for the Python implementation

This is **the opposite** of [`bloomberg-data`](bloomberg-data.md): there you read from Bloomberg, here you write to it.

## Reference architecture

```
+------------------+   +-------------------+   +-----------------------+
| Kafka consumer   |-->| FIX session DC A  |-->| <BB_DC_A_IP>:8228     |
| (background)     |   | (TLS mutual auth) |   | (Bloomberg DC A)      |
| pinned group_id  |   +-------------------+   +-----------------------+
| from_offset OK   |   +-------------------+   +-----------------------+
|                  |-->| FIX session DC B  |-->| <BB_DC_B_IP>:8228     |
+------------------+   | (TLS mutual auth) |   | (Bloomberg DC B)      |
                       +-------------------+   +-----------------------+

   Failover: DC A primary, DC B passive backup
   Trigger : DC A heartbeat timeout (>2x HeartBtInt)
            -> session moves to DC B, ResetSeqNumFlag=Y on new Logon
```

## Connection essentials

| Item               | Value                                            |
|--------------------|--------------------------------------------------|
| Port               | 8228                                             |
| Endpoints          | Bloomberg-issued (DC A in NY, DC B in NJ)        |
| TLS                | mutual auth, min TLS 1.2                         |
| Preferred cipher   | `TLS_ECDHE_RSA_AES_256_GCM_SHA384`               |
| CA                 | Bloomberg-issued (NOT a public CA)               |
| SenderCompID       | issued by Bloomberg                              |
| TargetCompID       | issued by Bloomberg (e.g. `<PREFIX>BETA`, prod)  |
| Source IP          | static, allowlisted with Bloomberg               |
| Heartbeat interval | 30 s typical (HeartBtInt min 1 / min)            |

## Service environment

Define everything via environment variables and keep the service disabled by default with kill switches:

```ini
[Service]
Environment="BLOOMBERG_FIX_ENABLED=false"       # Master kill switch
Environment="BLOOMBERG_FIX_DRY_RUN=true"        # Default: log, do not transmit
Environment="BLOOMBERG_FIX_HOST_A=<bb-dc-a-ip>"
Environment="BLOOMBERG_FIX_HOST_B=<bb-dc-b-ip>"
Environment="BLOOMBERG_FIX_PORT=8228"
Environment="BLOOMBERG_FIX_SENDER_COMP_ID="
Environment="BLOOMBERG_FIX_TARGET_COMP_ID="
Environment="BLOOMBERG_FIX_CERT_PATH=/etc/contrib/certs/bloomberg/client.pem"
Environment="BLOOMBERG_FIX_KEY_PATH=/etc/contrib/certs/bloomberg/client.key"
Environment="BLOOMBERG_FIX_CA_PATH=/etc/contrib/certs/bloomberg/bloomberg-ca.pem"
Environment="BLOOMBERG_FIX_HEARTBEAT_INTERVAL=30"
Environment="BLOOMBERG_FIX_KAFKA_TOPIC=prices.<asset>.<source>"
Environment="BLOOMBERG_FIX_PAGE_NUMBER="
```

## Python skeleton with `simplefix`

```python
import os, ssl, socket, logging
from datetime import datetime, timezone
import simplefix

ENABLED        = os.environ["BLOOMBERG_FIX_ENABLED"].lower() == "true"
DRY_RUN        = os.environ.get("BLOOMBERG_FIX_DRY_RUN", "true").lower() == "true"
HOST_A         = os.environ["BLOOMBERG_FIX_HOST_A"]
HOST_B         = os.environ["BLOOMBERG_FIX_HOST_B"]
PORT           = int(os.environ.get("BLOOMBERG_FIX_PORT", "8228"))
SENDER_COMP_ID = os.environ["BLOOMBERG_FIX_SENDER_COMP_ID"]
TARGET_COMP_ID = os.environ["BLOOMBERG_FIX_TARGET_COMP_ID"]
CERT_PATH      = os.environ["BLOOMBERG_FIX_CERT_PATH"]
KEY_PATH       = os.environ["BLOOMBERG_FIX_KEY_PATH"]
CA_PATH        = os.environ["BLOOMBERG_FIX_CA_PATH"]
HEARTBEAT      = int(os.environ.get("BLOOMBERG_FIX_HEARTBEAT_INTERVAL", "30"))

log = logging.getLogger("bloomberg-fix")


def make_tls_socket(host: str, port: int) -> ssl.SSLSocket:
    """Open TCP, then TLS mutual-auth socket against Bloomberg."""
    ctx = ssl.create_default_context(cafile=CA_PATH)
    ctx.load_cert_chain(certfile=CERT_PATH, keyfile=KEY_PATH)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    raw = socket.create_connection((host, port), timeout=10)
    return ctx.wrap_socket(raw, server_hostname=host)


def fix_logon(sock: ssl.SSLSocket, seq: int = 1) -> None:
    msg = simplefix.FixMessage()
    msg.append_pair(8, "FIXT.1.1")
    msg.append_pair(35, "A")                          # Logon
    msg.append_pair(49, SENDER_COMP_ID)
    msg.append_pair(56, TARGET_COMP_ID)
    msg.append_pair(34, str(seq))
    msg.append_utc_timestamp(52, precision=3)
    msg.append_pair(98, "0")                          # EncryptMethod = None (TLS at transport)
    msg.append_pair(108, str(HEARTBEAT))              # HeartBtInt
    msg.append_pair(141, "Y")                         # ResetSeqNumFlag
    msg.append_pair(1137, "9")                        # DefaultApplVerID = FIX50SP2
    sock.send(msg.encode())


def fix_heartbeat(sock: ssl.SSLSocket, seq: int) -> None:
    msg = simplefix.FixMessage()
    msg.append_pair(8, "FIXT.1.1")
    msg.append_pair(35, "0")                          # Heartbeat
    msg.append_pair(49, SENDER_COMP_ID)
    msg.append_pair(56, TARGET_COMP_ID)
    msg.append_pair(34, str(seq))
    msg.append_utc_timestamp(52, precision=3)
    sock.send(msg.encode())


def fix_setup_monitor(sock: ssl.SSLSocket, seq: int, page_number: str) -> None:
    """USMQ -- SetupMonitorRequest. Binds the session to a Bloomberg page."""
    msg = simplefix.FixMessage()
    msg.append_pair(8, "FIXT.1.1")
    msg.append_pair(35, "USMQ")
    msg.append_pair(49, SENDER_COMP_ID)
    msg.append_pair(56, TARGET_COMP_ID)
    msg.append_pair(34, str(seq))
    msg.append_utc_timestamp(52, precision=3)
    msg.append_pair(8013, page_number)                # MonitorPage (Bloomberg custom tag)
    sock.send(msg.encode())


def fix_market_data_incremental(sock: ssl.SSLSocket, seq: int, entries: list[dict]) -> None:
    """35=X MarketDataIncrementalRefresh.

    `entries`: list of dicts {isin, bid, ask, bid_size, ask_size}.
    Bundles up to 10 entries per message (Bloomberg best practice).
    """
    msg = simplefix.FixMessage()
    msg.append_pair(8, "FIXT.1.1")
    msg.append_pair(35, "X")
    msg.append_pair(49, SENDER_COMP_ID)
    msg.append_pair(56, TARGET_COMP_ID)
    msg.append_pair(34, str(seq))
    msg.append_utc_timestamp(52, precision=3)

    msg.append_pair(268, str(len(entries) * 2))       # NoMDEntries: 1 bid + 1 offer
    for e in entries:
        # Bid
        msg.append_pair(279, "0")                     # MDUpdateAction = New
        msg.append_pair(269, "0")                     # MDEntryType   = Bid
        msg.append_pair(48,  e["isin"])
        msg.append_pair(22,  "1")                     # SecurityIDSource = ISIN
        msg.append_pair(270, str(e["bid"]))
        if e.get("bid_size"):
            msg.append_pair(271, str(int(e["bid_size"])))
        # Offer
        msg.append_pair(279, "0")
        msg.append_pair(269, "1")                     # MDEntryType = Offer
        msg.append_pair(48,  e["isin"])
        msg.append_pair(22,  "1")
        msg.append_pair(270, str(e["ask"]))
        if e.get("ask_size"):
            msg.append_pair(271, str(int(e["ask_size"])))

    if DRY_RUN:
        log.info(f"DRY_RUN 35=X with {len(entries)} bonds: {msg.encode()[:300]}")
        return
    sock.send(msg.encode())
```

## Best practices reference

| Constraint           | Value                                | Source                |
|----------------------|--------------------------------------|-----------------------|
| Bundling             | up to 10 MDEntries per 35=X          | FIX-MPF best practices |
| Throughput           | ~4500 msg/s single, ~26k entries/s with bundling | idem |
| Dedup window         | 60 s on (instrument, side, price)    | FIX-MPF spec sect. 5.3 |
| Rate limit           | USMQ / UMPQ: 6000 updates / min / feed | Bloomberg account rules |
| Post-init delay      | wait ~3 minutes after Logon before first 35=X | Best practices |
| Heartbeat            | min 1 / min, timeout 2 min without activity | Logon tag 108 |
| Session inactivity   | > 95 days -> session disabled         | Account rules         |
| IP inactivity        | > 188 days -> IP removed from allowlist | Account rules       |

## Main workflows

### Connect + setup

1. TCP + TLS mutual auth to DC A `:8228` -> connection established
2. Logon (35=A) with SenderCompID + TargetCompID + HeartBtInt + ResetSeqNumFlag=Y
3. Bloomberg replies Logon (35=A) -> session up
4. Heartbeat thread starts (every `HEARTBEAT` seconds)
5. Wait ~3 minutes post-init
6. SetupMonitorRequest (USMQ) for the target page
7. Bloomberg acknowledges via UMDA (MarketDataAck)
8. Ready to publish

### Publish a batch

For each batch of up to 10 instruments from the upstream feed:

1. Build 35=X with `NoMDEntries = batch_size * 2` (bid + ask each)
2. Per instrument:
   - Bid: `MDUpdateAction=New, MDEntryType=Bid, SecurityID=ISIN, SecurityIDSource=1, MDEntryPx=bid, MDEntrySize=bid_size`
   - Ask: same with `MDEntryType=Offer`
3. Send
4. Track UMDA for that batch (5s timeout -> log)

### Failover DC A -> DC B

1. Detect heartbeat miss (no `TestRequest` reply within 2 * `HEARTBEAT`)
2. Log + alert
3. Establish new session on DC B
4. Logon with `ResetSeqNumFlag=Y`
5. Re-USMQ and resume publishing
6. Background retry of DC A every 30 s for failback

## The seven pitfalls

### 1. `simplefix` vs `quickfix-python`: encoding and dictionary

`simplefix` returns `bytes` from `msg.encode()`, has no built-in FIX 5.0 SP2 data dictionary. Bloomberg custom tags (e.g. `8013 MonitorPage`) must be added as raw pairs with no validation.

`quickfix-python` validates against an XML dictionary but is awkward to package on Debian 12. Start with `simplefix`, migrate to `quickfix-python` only if you hit a wall (compression, complex repeating groups).

### 2. `ResetSeqNumFlag=Y` is required on first Logon

Bloomberg remembers the sequence number from the previous session. Without `ResetSeqNumFlag=Y` (tag 141) on first Logon after a restart, your messages get rejected with `MsgSeqNum too low`. After that, increment seq numbers manually.

### 3. CA is Bloomberg-issued, not a public CA

```python
ssl.create_default_context(cafile=CA_PATH)   # MUST point to Bloomberg's CA
```

Calling `cafile=None` defaults to `/etc/ssl/certs`, which won't validate Bloomberg's chain. Symptoms: handshake fails with `unable to get local issuer certificate`.

### 4. IP allow-listing is strict

Bloomberg checks the source IP on every connection. If the egress IP changes (NAT update, new firewall), Bloomberg silently refuses: `TCP RST` or `timeout`, no explicit error message.

Always verify the egress IP before starting the contributor:

```bash
curl ifconfig.me   # confirm the IP matches what Bloomberg has allow-listed
```

### 5. Page must exist before USMQ

Sending `USMQ` for a non-existent page returns a `UMDA reject`. The page is provisioned by Bloomberg during onboarding -- verify in `EC <GO>` (Enterprise Console) on the Bloomberg terminal before testing.

### 6. 60-second dedup window

Same `(instrument, side, price)` within 60 s gets deduplicated by Bloomberg. To force a refresh, use `MDUpdateAction=Change` (tag 279=1) instead of `New`. Better: deduplicate in your watcher so you only send genuinely new prices.

### 7. Bundling > 10 entries degrades throughput

Bloomberg recommends ten or fewer MDEntries per message. Above that, you can get throttled and see ACK latency climb past 5 seconds.

## Test and debug

### TLS handshake alone

```bash
openssl s_client -connect <bb-dc-a-ip>:8228 \
  -cert /etc/contrib/certs/bloomberg/client.pem \
  -key  /etc/contrib/certs/bloomberg/client.key \
  -CAfile /etc/contrib/certs/bloomberg/bloomberg-ca.pem \
  -tls1_2
# Success: "Verify return code: 0 (ok)"
# Failure: certificate CN, missing CA, expiration
```

### Logon dry-run with pcap

```bash
tcpdump -i any -w /tmp/fix.pcap host <bb-dc-a-ip> and port 8228
# Inspect in Wireshark: Analyze > Decode As > FIX
```

### Bloomberg-side session view

`EC <GO>` on a Bloomberg terminal shows session logs: Logon attempts, rejections, UMDA errors.

### End-to-end latency

Persist timestamps per event in a time-series store (QuestDB works well):

```sql
SELECT
  source_file,
  isin,
  upstream_timestamp,
  watcher_received_at,
  service_received_at,
  kafka_offset_ts,
  fix_send_ts,
  umda_recv_ts,
  (fix_send_ts - upstream_timestamp) AS pipeline_latency_ms,
  (umda_recv_ts - fix_send_ts)       AS bloomberg_ack_latency_ms
FROM bonds_prices_ticks
WHERE upstream_timestamp > now() - 1h
ORDER BY upstream_timestamp DESC;
```

Reasonable targets:
- Internal pipeline (upstream to `35=X` sent): 200 to 800 ms
- Bloomberg ACK (UMDA): 50 to 300 ms
- End-to-end p95: < 1.5 s

## Onboarding checklist before first connection

- [ ] CSR submitted to Bloomberg account contact
- [ ] TLS cert + key + CA received and stored mode `0600`, owner `root:root`
- [ ] SenderCompID received
- [ ] Egress IP confirmed and communicated for allow-listing
- [ ] Firewall outbound rule: server -> DC A and DC B on `:8228`
- [ ] Test page provisioned and visible in `EC <GO>`
- [ ] Systemd unit created with `BLOOMBERG_FIX_ENABLED=false` (disabled by default)
- [ ] Persistence schema in place with latency columns
- [ ] Dry-run pass with synthetic Kafka payloads (no Bloomberg connection)

## When the certs are ready and you go live

1. Logon dry-run -> Logon ack
2. Heartbeat exchange for 5 minutes to confirm stability
3. USMQ on the test page
4. 35=X with 1 instrument (no bundling) in dry-run
5. Verify UMDA received in logs
6. Move to 10 bundled instruments
7. Measure end-to-end latency
8. Bring up DC B as passive
9. Failover test (kill DC A) -> DC B takes over
10. Move to production endpoints (IPs, TargetCompID, prod certs)
