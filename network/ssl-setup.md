---
name: ssl-setup
description: "Set up HTTPS for a web service: pick between Let's Encrypt (Caddy), self-signed (internal CA), or commercial certs; reverse proxy with WebSocket support; auto-renewal; expiry monitoring."
---

# SSL/TLS Setup

Three certificate strategies, three reverse-proxy templates, automatic renewal, and expiry monitoring. Pick the strategy that matches the deployment and copy the relevant config.

## Choose a strategy

| Environment                         | Method                                | Tool                     |
|-------------------------------------|---------------------------------------|--------------------------|
| Public internet, single domain      | Let's Encrypt (ACME)                  | Caddy (simplest)         |
| Public internet, wildcard           | Let's Encrypt with DNS-01             | Caddy + DNS module       |
| Internal only (`*.internal.lan`)    | Self-signed or internal CA            | OpenSSL or step-ca       |
| High-assurance, external partners   | Commercial (DigiCert, Sectigo, etc.)  | Manual purchase + renew  |

When in doubt, default to Let's Encrypt via Caddy. The renewal logic is built in, the configuration is one line per site, and the only thing you have to remember is to expose port 80 for the HTTP-01 challenge (or port 443 for ALPN-01).

## Caddy: Let's Encrypt automatic

Caddy handles both initial certificate issuance and renewal. The `Caddyfile` is one block per site.

```caddyfile
<domain> {
    reverse_proxy localhost:<backend-port>

    # WebSocket support (Caddy auto-detects, the explicit block is for clarity)
    @websocket {
        header Connection *Upgrade*
        header Upgrade    websocket
    }
    reverse_proxy @websocket localhost:<backend-port>

    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options    "nosniff"
        X-Frame-Options           "DENY"
        Referrer-Policy           "strict-origin-when-cross-origin"
    }

    log {
        output file /var/log/caddy/<domain>.log
    }
}
```

Reload:

```bash
sudo systemctl reload caddy
```

## Self-signed certificate (internal-only services)

For services that never leave the LAN.

```bash
# Single hostname
sudo openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout /etc/ssl/private/<service>.key \
  -out    /etc/ssl/certs/<service>.crt \
  -subj   "/CN=<hostname>.<domain>/O=<org>"

# With Subject Alternative Names (recommended; modern clients reject CN-only)
sudo openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout /etc/ssl/private/<service>.key \
  -out    /etc/ssl/certs/<service>.crt \
  -subj   "/CN=<hostname>" \
  -addext "subjectAltName=DNS:<hostname>,DNS:<hostname>.<domain>,IP:<ip>"
```

Distribute the cert as a trusted root on client machines (group policy, MDM, manual install). Otherwise every browser flags it.

For a real internal CA, use `step-ca` or HashiCorp Vault rather than rolling your own.

## Nginx reverse proxy (alternative to Caddy)

```nginx
server {
    listen 443 ssl http2;
    server_name <domain>;

    ssl_certificate     /etc/ssl/certs/<domain>.crt;
    ssl_certificate_key /etc/ssl/private/<domain>.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # WebSocket endpoint
    location /ws {
        proxy_pass http://localhost:<backend-port>;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_read_timeout 86400;   # 24h for long-lived sockets
    }

    # Everything else
    location / {
        proxy_pass http://localhost:<backend-port>;
        proxy_set_header Host             $host;
        proxy_set_header X-Real-IP        $remote_addr;
        proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name <domain>;
    return 301 https://$host$request_uri;
}
```

If your nginx is older than 1.25.1 and you proxy WebSockets, see [`nginx-websocket`](nginx-websocket.md) for the three traps that silently break the upgrade handshake.

## Renewal

| Method                   | Renewal      | Action                                                |
|--------------------------|--------------|-------------------------------------------------------|
| Caddy + Let's Encrypt    | Automatic    | Nothing to do                                         |
| Certbot + Let's Encrypt  | Cron / timer | `certbot renew --dry-run` once after install          |
| Self-signed              | Manual       | Calendar reminder before expiry                       |
| Commercial               | Manual       | Reorder ~30 days before expiry                        |

## Monitoring certificate expiry

Probe via `blackbox_exporter` and alert on `probe_ssl_earliest_cert_expiry`:

```yaml
# prometheus.yml
- job_name: 'ssl'
  metrics_path: /probe
  params:
    module: [http_2xx]
  static_configs:
    - targets: ['https://<domain>']
  relabel_configs:
    - source_labels: [__address__]
      target_label: __param_target
    - target_label: __address__
      replacement: localhost:9115
```

Alert rule (expiry within 30 days):

```yaml
- alert: SSLCertExpiringSoon
  expr: (probe_ssl_earliest_cert_expiry - time()) / 86400 < 30
  for: 1h
  annotations:
    summary: "SSL cert for {{ $labels.instance }} expires in {{ $value | humanize }} days"
```

## Checklist

- [ ] Certificate obtained (Let's Encrypt / self-signed / commercial)
- [ ] Reverse proxy configured (Caddy or Nginx)
- [ ] HTTP -> HTTPS redirect in place
- [ ] WebSocket works over WSS (test with `wscat -c wss://<domain>/ws`)
- [ ] Security headers set (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
- [ ] Automatic renewal configured or manual reminder scheduled
- [ ] Expiry monitoring + alert in Prometheus / Grafana
- [ ] Smoke test passes: `curl -v https://<domain>` returns the expected status
