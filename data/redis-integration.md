---
name: redis-integration
description: "Integrate Redis into FinTech and trading services: deployment on LXC, ACL auth, key layout, caching, pub-sub fan-out, rate limits, webhook dedup, distributed locks, and the seven recurrent production pitfalls."
---

# Redis Integration Patterns

How to wire Redis into a trading or FinTech back-end for caching, pub-sub, rate limiting, session state, and cross-process coordination. Patterns here come from running Redis beside PostgreSQL and QuestDB on LXC hosts serving matching platforms, treasury dashboards, and OAuth rotation plugins.

## When to use

- New service that needs a fast shared cache (balances, limits, model lists) across multiple app instances
- WebSocket or SSE fan-out where every API node must see the same live mid / session event
- Webhook or message deduplication (SET NX + TTL) before hitting the durable store
- Rate limiting external API calls (Bloomberg, Circle, Codex usage endpoints) without hammering upstream
- Distributed locks when two processes share one account store or one limit-refresh queue
- Session or token metadata that should survive process restarts but does not belong in PostgreSQL

## When **not** to use Redis

- Primary source of truth for orders, trades, or balances — PostgreSQL (or your ledger) owns that
- Long-term audit history — use PostgreSQL + Kafka, not Redis TTL keys
- Large blobs (>512 KB per value) — object storage or the DB is cheaper and safer
- "We might need caching someday" with no measured hot path — add Redis when you have evidence, not speculatively

## Deployment shape (reference)

| Item              | Dev / staging              | Production                                      |
|-------------------|----------------------------|-------------------------------------------------|
| Topology          | Single `redis-server`      | Sentinel (3 nodes) or Redis Cluster (6+)        |
| Version           | Redis 7.x                  | Redis 7.x, pin minor in apt / image tag         |
| Persistence       | RDB snapshots optional     | AOF `appendfsync everysec` + nightly RDB        |
| Memory cap        | `maxmemory 256mb`          | `maxmemory` + `maxmemory-policy allkeys-lru`    |
| Network           | `127.0.0.1:6379`           | Private VLAN only; TLS (`rediss://`) if crossed |
| Auth              | ACL user per service       | ACL user per service, no `default` full access  |

On Proxmox LXC, Redis fits comfortably in a 512 MB–1 GB CT alongside a small API. Size the CT for **peak** memory (Redis working set + OS + client buffers), not idle usage.

## Install on Debian / Ubuntu LXC

```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
```

Minimal hardened `redis.conf` overrides (drop under `/etc/redis/redis.conf.d/local.conf` or edit the main file):

```conf
bind 127.0.0.1 ::1
protected-mode yes
port 6379

# Memory — set to ~70% of CT RAM minus OS headroom
maxmemory 512mb
maxmemory-policy allkeys-lru

# Persistence — AOF for durability without blocking every write
appendonly yes
appendfsync everysec

# Disable commands you will never need from app users
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command CONFIG ""
```

Reload:

```bash
sudo systemctl restart redis-server
redis-cli ping   # expect PONG
```

Docker alternative (same host, useful for dev):

```bash
docker run -d --name redis \
  -p 6379:6379 \
  --restart unless-stopped \
  redis:7-alpine \
  redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
```

## Create an ACL service user

Never give application code the `default` user. Create one ACL entry per service:

```bash
# Generate and store the password (root-owned, 0600)
REDIS_PASS=$(openssl rand -base64 24)
echo "$REDIS_PASS" | sudo tee /etc/redis/secrets/matching-api-password >/dev/null
sudo chmod 600 /etc/redis/secrets/matching-api-password

# Append to redis.conf (or use ACL LOAD at runtime in Redis 6+)
sudo tee -a /etc/redis/redis.conf.d/acl.conf <<EOF
user matching-api on >${REDIS_PASS} ~matching:* ~cache:* +@read +@write +@string +@hash +@set +@sortedset +@list -@dangerous
user default on nopass ~* &* +@all
EOF

sudo systemctl restart redis-server
```

Connection string for the app:

```bash
export REDIS_URL="redis://matching-api:${REDIS_PASS}@127.0.0.1:6379/0"
# TLS-terminated proxy or managed Redis:
# export REDIS_URL="rediss://default:password@redis.internal:6380"
```

The `~matching:*` key pattern limits blast radius if credentials leak.

## Key naming conventions

| Pattern                              | Example                                      | Purpose                          |
|--------------------------------------|----------------------------------------------|----------------------------------|
| `<svc>:cache:<namespace>:<hash>:<ver>` | `treasury:cache:gateway-balance:a1b2:v3`   | Versioned response cache         |
| `<svc>:ver:<entity>`                 | `treasury:ver:0xabc123`                      | Per-entity version counter (INCR) |
| `<svc>:lock:<name>`                  | `multi-auth:lock:store-write`                | Distributed mutex                |
| `<svc>:webhook:<notification-id>`    | `treasury:webhook:evt-uuid`                  | Idempotency marker (SET NX)      |
| `<svc>:session:<id>`                 | `matching:session:550e8400-e29b-41d4-a716`  | Ephemeral session blob           |
| `<svc>:ratelimit:<bucket>`           | `codex:ratelimit:usage-api:acc-1`            | Sliding / fixed window counter   |
| `<svc>:pubsub:<channel>`             | (channel name, not a key) `matching:mids`    | Live mid fan-out                 |

Rules:

- Lowercase, colon-separated, service prefix first — makes ACL patterns and `KEYS` debugging tolerable.
- Never embed PII or raw tokens in key names; hash or truncate identifiers.
- Always set a TTL on cache and dedup keys. Unbounded keys are how Redis OOMs at 03:00.

## Pattern 1: Versioned response cache

Bump a per-entity version when data changes; fold versions into the cache key so invalidation is `INCR`, not `SCAN` + `DEL`.

```python
import hashlib
import json
import redis

r = redis.from_url("redis://matching-api:SECRET@127.0.0.1:6379/0", decode_responses=True)

def version_token(aliases: list[str]) -> str:
    keys = sorted({f"treasury:ver:{a.lower()}" for a in aliases})
    versions = r.mget(keys) if keys else []
    return "v" + ".".join(v or "0" for v in versions)

def cache_key(namespace: str, parts: list[str], ver: str) -> str:
    digest = hashlib.sha256("|".join(sorted(p.lower() for p in parts)).encode()).hexdigest()[:16]
    return f"treasury:cache:{namespace}:{digest}:{ver}"

def get_or_set_json(key: str, ttl_sec: int, loader):
    cached = r.get(key)
    if cached:
        return json.loads(cached)
    value = loader()
    r.set(key, json.dumps(value), ex=ttl_sec)
    return value

# After a webhook or trade event touches address 0xabc:
r.incr("treasury:ver:0xabc123")
r.expire("treasury:ver:0xabc123", 86400)
```

Node (ioredis) — same idea:

```javascript
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

export async function bumpBalanceVersion(addresses) {
  const pipeline = redis.pipeline();
  for (const addr of new Set(addresses.map((a) => a.toLowerCase()))) {
    pipeline.incr(`treasury:ver:${addr}`);
    pipeline.expire(`treasury:ver:${addr}`, 86400);
  }
  await pipeline.exec();
}
```

**Fail open:** if Redis is down, skip the cache and serve uncached. Trading and treasury UIs must not hard-depend on Redis being up.

## Pattern 2: Pub-sub for live mids / session events

PostgreSQL owns session state; Redis pub-sub pushes deltas to every WebSocket worker.

Publisher (after a match or mid update):

```python
payload = json.dumps({"session_id": str(session_id), "maturity": "5y", "mid": 7.5025})
r.publish("matching:mids", payload)
```

Subscriber (each API / WS worker):

```python
pubsub = r.pubsub()
pubsub.subscribe("matching:mids")
for message in pubsub.listen():
    if message["type"] != "message":
        continue
    event = json.loads(message["data"])
    broadcast_to_local_websockets(event)
```

Pub-sub is fire-and-forget: subscribers offline during publish miss the message. For recovery, clients still poll or resubscribe with a snapshot from PostgreSQL / cache.

## Pattern 3: Webhook idempotency (SET NX)

Fast-path dedup before the durable insert. Supabase / PostgreSQL unique constraints remain the source of truth; Redis just rejects obvious retries cheaply.

```python
def mark_webhook_seen(notification_id: str, ttl_sec: int = 86400) -> str:
    key = f"treasury:webhook:{notification_id}"
    if r.set(key, "1", nx=True, ex=ttl_sec):
        return "new"
    return "duplicate"
```

If the durable insert fails after Redis accepted the marker, **delete** the key so the provider's retry can be reprocessed:

```python
r.delete(f"treasury:webhook:{notification_id}")
```

## Pattern 4: Distributed lock

Use for account-store writes, limit-refresh queues, or any "only one runner" job. Keep TTL short; the holder must finish before expiry.

```python
import uuid

def acquire_lock(name: str, ttl_ms: int = 30_000) -> str | None:
    token = str(uuid.uuid4())
    ok = r.set(f"multi-auth:lock:{name}", token, nx=True, px=ttl_ms)
    return token if ok else None

def release_lock(name: str, token: str) -> None:
    # Compare-and-delete — never DEL blindly
    script = """
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    else
      return 0
    end
    """
    r.eval(script, 1, f"multi-auth:lock:{name}", token)
```

Redlock across multiple independent Redis masters is rarely worth the complexity on a private VLAN; a single Redis with Sentinel failover is the default for FinTech internal infra.

## Pattern 5: Rate limiting upstream API calls

Fixed window counter — good enough for Codex usage / Bloomberg REST pacing:

```python
def allow_request(bucket: str, limit: int, window_sec: int) -> bool:
    key = f"codex:ratelimit:{bucket}"
    pipe = r.pipeline()
    pipe.incr(key)
    pipe.expire(key, window_sec, nx=True)
    count, _ = pipe.execute()
    return int(count) <= limit
```

For strict sliding windows, use a sorted set of timestamps; for most broker-side integrations a fixed window + conservative limit is sufficient.

## Environment variable convention

Standardise on one URL per service:

```bash
REDIS_URL=redis://matching-api:SECRET@127.0.0.1:6379/0
# or service-specific prefix to avoid collisions on shared Redis:
OPENCODE_MULTI_AUTH_REDIS_URL=redis://127.0.0.1:6379
```

Optional clients should treat a missing URL as "caching disabled", not a startup failure.

## Monitoring

Install `redis_exporter` and scrape with Prometheus:

```bash
# Example: binary or container on the same host
redis_exporter --redis.addr=redis://127.0.0.1:6379
```

Alert on:

| Metric / signal              | Threshold (starting point)     |
|------------------------------|--------------------------------|
| `redis_memory_used_bytes`    | > 85% of `maxmemory`           |
| `redis_connected_clients`    | Sudden 3× spike               |
| `redis_evicted_keys_total`   | Sustained > 0 (cache too small)|
| `redis_master_link_up`       | 0 on replica (Sentinel env)    |
| `redis_up`                   | 0 for > 1 minute               |

CLI health during incidents:

```bash
redis-cli -u "$REDIS_URL" INFO memory | egrep 'used_memory_human|maxmemory'
redis-cli -u "$REDIS_URL" INFO stats  | egrep 'instantaneous_ops|keyspace'
redis-cli -u "$REDIS_URL" --scan --pattern 'treasury:ver:*' | head
redis-cli -u "$REDIS_URL" SLOWLOG GET 10
```

## Seven recurrent pitfalls

1. **No TTL on cache keys** — memory grows until OOM; every cache write gets `EX` or `PX`.
2. **Using Redis as source of truth** — a restart or flush loses orders; PostgreSQL (or Kafka + sink) owns durable state.
3. **`KEYS *` in production** — blocks the server; use `SCAN` or track key prefixes in design docs.
4. **Default user with no password on `0.0.0.0`** — bind to localhost or private VLAN + ACL + password always.
5. **Pub-sub as guaranteed delivery** — it is not; pair with periodic snapshot / poll for recovery.
6. **Lock without token check on release** — two workers can both think they hold the lock; always compare-and-delete.
7. **Hard dependency on Redis** — app refuses to start or serve when Redis is down; degrade to uncached / in-process fallback instead.

## Integration checklist

- [ ] Redis bound to private / localhost; not exposed on the public internet
- [ ] ACL user per service with key-pattern restriction (`~prefix:*`)
- [ ] `maxmemory` + eviction policy configured
- [ ] AOF (prod) or explicit decision to accept ephemeral-only data (dev)
- [ ] Password stored root-owned `0600`, injected via env / secret manager
- [ ] Key naming doc agreed with the team (prefix, TTL policy)
- [ ] App fails open when Redis unreachable
- [ ] Webhook dedup: Redis SET NX **plus** durable unique constraint
- [ ] `redis_exporter` scraped; memory and evictions alerted
- [ ] Restore / failover tested (Sentinel promote or rebuild from empty cache)
