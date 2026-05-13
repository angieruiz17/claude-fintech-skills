---
name: prometheus-add-target
description: "Add a new host to a Prometheus monitoring stack: node_exporter scrape, ICMP blackbox probe with relabel for friendly host name, dashboard host-count update, hot reload via SIGHUP."
---

# Add a Host to Prometheus

Procedure to onboard a new host into a Prometheus + Grafana + blackbox-exporter stack, with the recurrent pitfalls and a tested hot-reload sequence.

## Stack assumptions

- Prometheus runs on a dedicated host with read access to `node_exporter` and `blackbox_exporter`
- `node_exporter` is installed on the target on port 9100
- `blackbox_exporter` runs on the Prometheus host (loopback) to probe ICMP
- Grafana reads dashboards from a directory (`/var/lib/grafana/dashboards/` or via provisioning)

If your stack is `node_exporter` only with no ICMP probing, skip the blackbox section.

## Step 1: add to the `node_exporter` job

In `prometheus.yml`:

```yaml
- job_name: node_exporter
  static_configs:
    - targets:
        # ... existing targets ...
        - "<TARGET-IP>:9100"   # <HOSTNAME> (<role>)
```

## Step 2: add to the ICMP blackbox job (optional)

```yaml
- job_name: blackbox_icmp
  metrics_path: /probe
  params:
    module: [icmp_probe]
  static_configs:
    - targets:
        - "<TARGET-IP>"   # <HOSTNAME>
      labels:
        site: <site-name>
  relabel_configs:
    - source_labels: [__address__]
      target_label: __param_target
    - source_labels: [__param_target]
      target_label: instance
    - target_label: __address__
      replacement: 127.0.0.1:9115
    # Friendly host name override
    - source_labels: [__param_target]
      regex: "<TARGET-IP>"
      target_label: host_name
      replacement: "<HOSTNAME>"
```

The `relabel_configs` block is essential: without the friendly `host_name` label, your dashboards will show raw IPs.

## Step 3: deploy + hot reload (no restart)

```bash
# Backup
sudo cp /etc/prometheus/prometheus.yml \
        /etc/prometheus/prometheus.yml.bak.$(date +%Y%m%d-%H%M)

# Replace
sudo cp /tmp/prometheus_new.yml /etc/prometheus/prometheus.yml
sudo chown prometheus:prometheus /etc/prometheus/prometheus.yml

# SIGHUP hot reload (no service restart, keeps the TSDB warm)
sudo kill -HUP "$(pidof prometheus)"
```

Prometheus reloads config on SIGHUP. If the new config is invalid, the reload fails but the old config keeps running: no outage. Confirm in `/var/log/prometheus/` or via `journalctl -u prometheus | tail`.

## Step 4: verify the target is up

```bash
curl -s 'http://localhost:9090/api/v1/targets' | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for t in data['data']['activeTargets']:
    inst = t.get('labels', {}).get('instance', '')
    job  = t.get('labels', {}).get('job', '')
    if '<TARGET-IP>' in inst:
        print(f'{job:25} {inst:30} {t[\"health\"]}')
"
```

Expected: both `node_exporter` and `blackbox_icmp` show `up`.

Direct ICMP probe smoke test:

```bash
curl -s 'http://localhost:9115/probe?target=<TARGET-IP>&module=icmp_probe' \
  | grep probe_success
# Should return: probe_success 1
```

## Step 5: update the "Hosts UP" dashboard count (if applicable)

Dashboards that show `Hosts UP / N` hard-code the total `N` in the panel title. After adding a target:

1. Edit the dashboard JSON (or in Grafana UI)
2. Find the relevant panel (often `id: 1`)
3. Increment the total in the title: `"Hosts UP / 55"` -> `"Hosts UP / 56"`
4. Deploy:

```bash
sudo cp /tmp/network-monitoring.json /var/lib/grafana/dashboards/
sudo chown grafana:grafana /var/lib/grafana/dashboards/network-monitoring.json
```

Grafana picks up file-based dashboards automatically within ~30 seconds.

If you use a provisioned dashboard from git, commit and push the JSON, and Grafana provisioning will reload.

## Removing or temporarily disabling a target

For a target that's temporarily unavailable (VM stopped, host being decommissioned), **comment out** the lines instead of deleting them. Preserves the history and makes reactivation a one-line change.

```yaml
# - "<TARGET-IP>:9100"   # <HOSTNAME> -- offline since YYYY-MM-DD, reactivate after <event>
```

Same for `blackbox_icmp` and its `relabel_configs` regex.

## Troubleshooting

| Symptom                                | Probable cause                              | Fix                                                |
|----------------------------------------|---------------------------------------------|----------------------------------------------------|
| `node_exporter` target is `down`       | Port 9100 not reachable                     | `ss -tlnp \| grep 9100` on the target, check firewall |
| `blackbox_icmp` target is `down`       | ICMP not allowed                            | Allow ICMP between Prometheus host and target       |
| Grafana shows "No data" after the add  | Scrape OK, dashboard not reloaded           | Wait 30 s; force reload Grafana                     |
| Total `Hosts UP / N` is wrong          | Panel title still has the old N             | Edit the panel title to match the new target count  |
| Hot reload doesn't pick up changes     | YAML syntax error in `prometheus.yml`       | `promtool check config prometheus.yml`              |
| Friendly name doesn't appear in panels | `host_name` relabel missing or regex wrong  | Verify `regex: "<TARGET-IP>"` matches exactly       |

## When this skill applies

- New host onboarded to the platform that needs monitoring
- Migration of an existing host (IP change requires updating both target and relabel)
- VM / container moved between nodes: update the static config
- Adding ICMP probing to a host that was only on `node_exporter`
- Adding a host to a multi-site dashboard with a `site` label
