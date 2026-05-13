---
name: database-design
description: "Database schema design for trading and FinTech back-ends: tech choice, naming, audit trail, migrations, indexing, backup, with reference DDL for a matching platform."
---

# Database Design for FinTech Back-ends

Working conventions for designing the persistence layer of a trading or matching system. Covers technology choice, naming, audit trails, migrations, indexing, and backup. Comes from years of running PostgreSQL, QuestDB, and Redis side by side in trading infrastructure.

## When to use

- Greenfield: picking the storage stack for a new service
- Designing the schema for a new entity (orders, trades, sessions, audit, users)
- Refactoring an existing schema before it ossifies
- Adding an audit trail to comply with internal or regulatory requirements

## Tech choice cheat sheet

| Need                                       | Default               | Why                                                       |
|--------------------------------------------|-----------------------|-----------------------------------------------------------|
| Relational, transactional state            | PostgreSQL            | Mature, JSON support, partitioning, rich tooling          |
| Time-series (market data, metrics, ticks)  | QuestDB or TimescaleDB | Built for high-ingest and time-range scans                |
| Cache and pub-sub                          | Redis                  | Fast, versatile, native pub-sub                           |
| Full-text search                           | PostgreSQL FTS or Meilisearch | Don't bring in Elasticsearch unless you really need it |
| Object storage (large blobs, snapshots)    | S3-compatible (MinIO)  | Cheaper than DB blobs, easier lifecycle policies          |

For a typical trading / matching platform:

- **PostgreSQL**: orders, trades, sessions, users, audit
- **QuestDB**: market-data history, latency / ack ticks
- **Redis**: live mid points, WS pub-sub fan-out

## Naming conventions

| Item            | Convention                          | Example                              |
|-----------------|-------------------------------------|--------------------------------------|
| Tables          | `snake_case`, plural                | `trades`, `matching_sessions`        |
| Columns         | `snake_case`                        | `trade_id`, `created_at`             |
| Primary keys    | `id`, type UUID v7 (time-sortable)  | -                                    |
| Foreign keys    | `<singular>_id`                     | `trader_id`, `session_id`            |
| Timestamps      | `created_at`, `updated_at`, UTC      | `TIMESTAMPTZ DEFAULT NOW()`          |
| Booleans        | `is_*` / `has_*`                    | `is_active`, `has_partial_fill`      |
| Enums           | UPPER_SNAKE in code, `VARCHAR` or PG enum on disk | `'OUTRIGHT'`, `'SPREAD'` |

UUID v7 (time-prefixed) is preferable to v4: it preserves insert order and clusters writes on the same B-tree page. PostgreSQL 17 ships native `uuidv7()`.

## Reference schema: matching platform

```sql
-- Sessions
CREATE TABLE matching_sessions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product            VARCHAR(20) NOT NULL,    -- swaps, fra, imm, fwdfwd, ois
    status             VARCHAR(20) NOT NULL,    -- idle, countdown, matching, ended
    stretch_bp         DECIMAL(6,3) NOT NULL,
    countdown_seconds  INT NOT NULL,
    matching_seconds   INT NOT NULL,
    started_at         TIMESTAMPTZ,
    ended_at           TIMESTAMPTZ,
    created_by         UUID NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Orders
CREATE TABLE orders (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID NOT NULL REFERENCES matching_sessions(id),
    trader_id          UUID NOT NULL REFERENCES users(id),
    maturity           VARCHAR(10) NOT NULL,    -- 1y, 2y, 5y, ...
    direction          VARCHAR(4)  NOT NULL,    -- buy, sell
    price              DECIMAL(10,4) NOT NULL,
    nominal_usd        INT NOT NULL,
    nominal_ccy        BIGINT,
    remaining_nominal  INT NOT NULL,
    status             VARCHAR(20) NOT NULL,    -- active, filled, partial, cancelled
    seq                INT NOT NULL,            -- FIFO sequence within (session, maturity, price)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Executed trades
CREATE TABLE trades (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     UUID NOT NULL REFERENCES matching_sessions(id),
    buy_order_id   UUID NOT NULL REFERENCES orders(id),
    sell_order_id  UUID NOT NULL REFERENCES orders(id),
    buyer_id       UUID NOT NULL REFERENCES users(id),
    seller_id      UUID NOT NULL REFERENCES users(id),
    maturity       VARCHAR(10)  NOT NULL,
    price          DECIMAL(10,4) NOT NULL,
    nominal_usd    INT NOT NULL,
    nominal_ccy    BIGINT,
    trade_type     VARCHAR(10)  NOT NULL,        -- outright, spread, fly
    executed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Audit trail (append-only)
CREATE TABLE audit_log (
    id           BIGSERIAL PRIMARY KEY,
    entity_type  VARCHAR(30) NOT NULL,           -- order, trade, session, user
    entity_id    UUID NOT NULL,
    action       VARCHAR(30) NOT NULL,           -- created, updated, cancelled, executed
    actor_id     UUID NOT NULL REFERENCES users(id),
    old_values   JSONB,
    new_values   JSONB,
    ip_address   INET,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`audit_log` is append-only by convention: no `UPDATE`, no `DELETE`. Enforce with revoked privileges or a `BEFORE UPDATE / DELETE` trigger that raises.

## Index strategy

```sql
-- Order book lookups, FIFO scan within (session, maturity, price)
CREATE INDEX idx_orders_session_status ON orders(session_id, status);
CREATE INDEX idx_orders_book           ON orders(session_id, maturity, direction, price, seq);

-- Trade audit / reporting
CREATE INDEX idx_trades_session     ON trades(session_id);
CREATE INDEX idx_trades_executed_at ON trades(executed_at);

-- Audit trail lookups
CREATE INDEX idx_audit_entity     ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created_at ON audit_log(created_at);
```

Rules:
- Cover **the** common access path first, not every theoretical query.
- Watch `EXPLAIN ANALYZE` on production queries before adding more indexes.
- Composite columns in the order the query filters them.

## Audit trail via trigger

```sql
CREATE OR REPLACE FUNCTION audit_trigger() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO audit_log (entity_type, entity_id, action, actor_id, old_values, new_values)
    VALUES (
        TG_TABLE_NAME,
        COALESCE(NEW.id, OLD.id),
        TG_OP,
        current_setting('app.current_user')::uuid,
        CASE TG_OP WHEN 'INSERT' THEN NULL ELSE row_to_json(OLD)::jsonb END,
        CASE TG_OP WHEN 'DELETE' THEN NULL ELSE row_to_json(NEW)::jsonb END
    );
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE OR DELETE
  ON orders FOR EACH ROW EXECUTE FUNCTION audit_trigger();
```

`current_setting('app.current_user')` is set by the application at the start of each connection (`SET LOCAL app.current_user = '<uuid>'`). That keeps the audit row attributable to a real user, even when the DB user is a generic service account.

## Migrations

- Use a real migration tool: **Alembic** (Python/SQLAlchemy), **dbmate** (lang-agnostic), or your framework's built-in.
- One migration per logical change. Keep them small.
- **Reversible** when feasible: write `down` even if you never plan to run it.
- Naming: `YYYYMMDDHHMMSS_short_description.sql`.
- **Never modify** a migration once it has been applied in production. Add a new migration instead.

For PostgreSQL specifically:

- `ALTER TABLE ... ADD COLUMN ... DEFAULT ... NOT NULL` is fast in PG 11+ (no full table rewrite).
- Adding an index in production: `CREATE INDEX CONCURRENTLY` to avoid table-level locks.
- Adding a foreign key on a large table: add with `NOT VALID`, then `VALIDATE CONSTRAINT` outside peak hours.

## Backup strategy

- **Logical dump** daily: `pg_dump --format=custom --compress=9 --verbose <db> > <dump>`
- **WAL archiving** for point-in-time recovery (`archive_command`, e.g. shipping segments to S3 / MinIO)
- **Retention**: 30 days minimum for most regulatory regimes
- **Restore test**: monthly minimum, on a separate environment

For QuestDB: snapshot the `data/` directory and the `seq.txt` together. Restoring from a half-snapshot is undefined.

## Hygiene checklist

- [ ] Schema documented (ERD or a one-page text description)
- [ ] Indexes on the actually-queried columns, verified by `EXPLAIN ANALYZE`
- [ ] Audit trail on any table whose history matters (orders, trades, users, permissions)
- [ ] Migrations versioned, in source control, reversible where possible
- [ ] Backup configured AND a recent restore test successful
- [ ] All timestamps `TIMESTAMPTZ`, UTC
- [ ] `NOT NULL` and foreign-key constraints in place
- [ ] No clear-text secrets: passwords hashed (`argon2id` or `bcrypt`), tokens encrypted at rest
- [ ] DB user has the minimum privileges the service actually needs
