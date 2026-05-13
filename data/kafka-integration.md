---
name: kafka-integration
description: "Integrate services with a Kafka cluster: SASL SCRAM auth, topic naming and retention, Python confluent-kafka consumer / producer, monitoring, and audit-feed schemas."
---

# Kafka Integration Patterns

How to wire a new service into a Kafka cluster, with the patterns refined on production market-data and trade-audit pipelines. Uses `confluent-kafka-python` (librdkafka), KRaft-mode brokers, and SCRAM-SHA-512 auth.

## When to use

- New service that needs to publish or consume from Kafka
- Standing up an audit feed (trades, orders, sessions) for downstream consumers (time-series store, search, analytics)
- Connecting two trading systems via a decoupled bus
- Designing topic names, partitioning, and retention

## Cluster shape (reference)

| Item                | Value                                             |
|---------------------|---------------------------------------------------|
| Mode                | KRaft (Kafka 3.7+, no ZooKeeper)                  |
| External listener   | `<broker>:9092` SASL_PLAINTEXT, SCRAM-SHA-512     |
| Internal listener   | `127.0.0.1:9094` no SASL, for local admin only    |
| Controller          | `127.0.0.1:9093`                                  |
| Auth                | SCRAM-SHA-512                                     |

`SASL_PLAINTEXT` is fine on a private trusted network; switch to `SASL_SSL` once the bus is reachable from outside that network.

## Create a SCRAM user

```bash
# Generate a strong password and persist it under root-owned 0600 storage
NEW_PASS=$(openssl rand -base64 24)
echo "$NEW_PASS" | sudo tee /etc/kafka/secrets/<svc>-password >/dev/null
sudo chmod 600 /etc/kafka/secrets/<svc>-password

# Create the user
sudo /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server 127.0.0.1:9094 \
  --alter \
  --add-config "SCRAM-SHA-512=[password=$NEW_PASS]" \
  --entity-type users \
  --entity-name <svc>

# Verify
sudo /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server 127.0.0.1:9094 \
  --describe --entity-type users | grep <svc>
```

The same `bootstrap-server 127.0.0.1:9094` admin path bypasses SASL (intentional for admin operations from the broker itself).

## Topic naming conventions

| Pattern                          | Example                            |
|----------------------------------|------------------------------------|
| `<domain>.<event-or-stream>`     | `market-data.bloomberg`            |
| `<service>.<entity>`             | `matching.trades`, `matching.orders`, `matching.sessions` |
| `prices.<source>.<asset-class>`  | `prices.gotx.rates`, `prices.gotx.fx` |

Avoid camelCase or under_scores: dots are the convention and play nicely with ACLs.

## Topic creation

```bash
for TOPIC in <svc>.orders <svc>.trades <svc>.sessions; do
  sudo /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server 127.0.0.1:9094 \
    --create \
    --topic "$TOPIC" \
    --partitions 3 \
    --replication-factor 1 \
    --config retention.ms=7776000000   # 90 days
done
```

Tuning hints:

- **Partitions**: pick the max parallelism you'll ever want for a single consumer group. Increasing later is supported, decreasing isn't.
- **Replication factor**: 1 for dev, 3 for prod. Don't ship to prod on RF=1.
- **Retention**: by time (`retention.ms`) and / or by size (`retention.bytes`). Audit feeds: weeks to months. Working buses: hours to days.

## Python consumer

```python
from confluent_kafka import Consumer, KafkaError
import json
import os

def create_consumer(group_id: str, *,
                    broker: str = os.environ["KAFKA_BROKER"],
                    username: str = os.environ["KAFKA_USERNAME"],
                    password: str = os.environ["KAFKA_PASSWORD"]) -> Consumer:
    return Consumer({
        "bootstrap.servers":  broker,
        "group.id":           group_id,
        "client.id":          f"{group_id}-consumer",
        "auto.offset.reset":  "latest",
        "enable.auto.commit": True,
        "security.protocol":  "SASL_PLAINTEXT",
        "sasl.mechanism":     "SCRAM-SHA-512",
        "sasl.username":      username,
        "sasl.password":      password,
    })


def consume(topic: str, group_id: str, on_message):
    consumer = create_consumer(group_id)
    consumer.subscribe([topic])
    try:
        while True:
            msg = consumer.poll(timeout=1.0)
            if msg is None:
                continue
            if msg.error():
                if msg.error().code() == KafkaError._PARTITION_EOF:
                    continue
                raise RuntimeError(msg.error())
            on_message(json.loads(msg.value()))
    finally:
        consumer.close()
```

The `group.id` is the consumer-group identity, used by Kafka to track offsets and balance partitions across N consumer processes. Don't share group IDs across unrelated services.

## Python producer

```python
from confluent_kafka import Producer
import json
import os


def create_producer(*,
                    broker: str = os.environ["KAFKA_BROKER"],
                    username: str = os.environ["KAFKA_USERNAME"],
                    password: str = os.environ["KAFKA_PASSWORD"]) -> Producer:
    return Producer({
        "bootstrap.servers": broker,
        "client.id":         "producer",
        "acks":              "all",      # wait for full ISR ack
        "linger.ms":         5,           # small batching window
        "compression.type":  "lz4",
        "security.protocol": "SASL_PLAINTEXT",
        "sasl.mechanism":    "SCRAM-SHA-512",
        "sasl.username":     username,
        "sasl.password":     password,
    })


def publish(producer: Producer, topic: str, key: str, payload: dict) -> None:
    producer.produce(
        topic,
        key=key.encode("utf-8"),
        value=json.dumps(payload).encode("utf-8"),
    )
    # Flush on a cadence, not after every message, to keep batching effective
```

Always set a `key`: it pins messages with the same key to the same partition, preserving per-key ordering. For trade and order feeds, use the trade ID or order ID.

## Example schemas

Market-data feed:

```json
{
  "ticker":     "SASW5 Curncy",
  "currency":   "ZAR",
  "rate_type":  "IRS",
  "tenor":      "5Y",
  "bid":        7.485,
  "ask":        7.585,
  "mid":        7.535,
  "timestamp":  "2026-04-08T10:00:00Z",
  "source":    "<source>",
  "desk":      "ZAR",
  "user":      "<user-id>"
}
```

Trade audit:

```json
{
  "id":           "<uuid>",
  "session_id":   "<uuid>",
  "buyer":        "<entity>",
  "seller":       "<entity>",
  "maturity":     "5y",
  "price":        7.50,
  "nominal_usd":  5000,
  "nominal_ccy":  228000000,
  "product":      "swaps",
  "trade_type":   "outright",
  "executed_at":  "2026-04-08T10:15:23Z"
}
```

Schemas are best enforced with a registry (Confluent Schema Registry, Apicurio) once you have more than a few topics; JSON in production without a registry is convenient but bites back on every breaking change.

## Monitoring

```bash
# Topics
sudo /opt/kafka/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9094 --list

# Consumer groups
sudo /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server 127.0.0.1:9094 --list

# Lag for a specific group
sudo /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server 127.0.0.1:9094 --describe --group <group-id>

# Tap a topic to inspect a few messages
sudo /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server 127.0.0.1:9094 \
  --topic <topic> --from-beginning --max-messages 5
```

For Prometheus-based monitoring, add the Kafka JMX exporter and scrape these metrics: `kafka_consumergroup_lag`, `kafka_server_brokertopicmetrics_bytesinpersec_count`, `kafka_controller_kafkacontroller_activecontrollercount`.

## Integration checklist

- [ ] SCRAM user created on the broker, password persisted under `0600` ownership
- [ ] Topics created with appropriate partitions and retention
- [ ] Consumer up, group visible in `--list`, lag converging to 0
- [ ] Producer publishes with `acks=all`, keys present for ordered streams
- [ ] Schemas documented (and ideally enforced via a registry)
- [ ] Lag and broker metrics exposed to Prometheus
- [ ] Alert: consumer lag > N for > M minutes
- [ ] Downstream sink (time-series DB / search / data lake) consuming the audit topics
