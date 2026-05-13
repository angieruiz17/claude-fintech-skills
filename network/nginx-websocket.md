---
name: nginx-websocket
description: Set up nginx as a reverse proxy for WebSocket connections without falling into the three classic traps (HTTP/2, hardcoded Connection header with keepalive, default timeouts).
---

# Nginx WebSocket Reverse Proxy

How to put nginx in front of a WebSocket back-end without breaking the upgrade handshake. Distilled from production incidents on Jitsi Meet, real-time trading dashboards, matching engines, and Rust-based remote-desktop services.

## When to use

- nginx returns `200 OK` instead of `101 Switching Protocols` on a WebSocket endpoint
- WebSocket works once, then every subsequent connection from the same client breaks
- WebSocket connections drop after exactly 60 seconds
- Any new vhost that proxies a WebSocket back-end

## The three traps that break WebSocket

### Trap 1: HTTP/2 incompatible with WebSocket (nginx < 1.25.1)

**Symptom**: client receives `HTTP/2 200` instead of `HTTP/1.1 101 Switching Protocols`. Modern browsers force HTTP/2, so the upgrade fails silently and falls back to long-polling (or just dies).

**Cause**: nginx versions before 1.25.1 do not implement RFC 8441 (Extended CONNECT), the HTTP/2-over-WebSocket upgrade path.

**Fix**: either upgrade nginx, or disable HTTP/2 on the affected vhost:

```bash
nginx -v
# nginx/1.22.1 -> affected
# nginx/1.25.1+ -> fine

# If stuck on an older nginx (e.g. Debian 12 stable ships 1.22):
sudo sed -i 's/listen 443 ssl http2;/listen 443 ssl;/' /etc/nginx/sites-enabled/<vhost>.conf
sudo sed -i 's|listen \[::\]:443 ssl http2;|listen [::]:443 ssl;|' /etc/nginx/sites-enabled/<vhost>.conf
sudo nginx -t && sudo systemctl reload nginx
```

You lose HTTP/2 multiplexing on that vhost. For pure WebSocket back-ends this is acceptable; for mixed REST + WS, split into two vhosts (or two ports) and reload.

### Trap 2: Hardcoded `Connection: upgrade` with upstream keepalive

**Symptom**: the first WebSocket connects fine. Every subsequent one returns 200 instead of 101.

**Cause**: `proxy_set_header Connection "upgrade"` injects the header unconditionally. When the upstream block has `keepalive N`, nginx reuses an existing TCP connection but keeps sending the upgrade header on regular HTTP requests, corrupting the conversation.

**Fix**: use a conditional map so the `Connection` header is only sent when the client actually requested an upgrade.

```nginx
# /etc/nginx/conf.d/websocket_upgrade.conf  (global, once for the whole instance)
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Then in the vhost:

```nginx
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection $connection_upgrade;     # <- the conditional one
```

### Trap 3: Default timeouts too short for long-lived sockets

**Symptom**: WebSockets close after exactly 60 seconds of inactivity.

**Cause**: `proxy_read_timeout` defaults to 60s. Real-time apps with no chatter inside that window get culled.

**Fix**:

```nginx
proxy_read_timeout 900s;     # 15 min, tune to your heartbeat
proxy_send_timeout 900s;
tcp_nodelay on;
```

Combine this with an application-level heartbeat (server sends a ping every 25-30s) so connections never reach the timeout.

## Full reference vhost

```nginx
# /etc/nginx/conf.d/websocket_upgrade.conf
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

```nginx
# /etc/nginx/sites-enabled/example.conf
upstream backend_ws {
    server 127.0.0.1:8080;
    keepalive 8;             # safe thanks to the map above
}

server {
    listen 443 ssl;          # NOT http2 if nginx < 1.25.1
    listen [::]:443 ssl;
    server_name example.com;

    ssl_certificate     /etc/ssl/certs/example.com.crt;
    ssl_certificate_key /etc/ssl/private/example.com.key;

    location /ws {
        proxy_pass http://backend_ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host       $http_host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
        tcp_nodelay on;
    }
}
```

## Diagnose with curl

```bash
curl -sk --http1.1 \
     -H 'Connection: Upgrade' \
     -H 'Upgrade: websocket' \
     -H 'Sec-WebSocket-Version: 13' \
     -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
     -H 'Host: example.com' \
     -D /dev/stdout -o /dev/null \
     'https://localhost/ws' | head -5
```

Expected output:
```
HTTP/1.1 101 Switching Protocols
Connection: upgrade
Upgrade: websocket
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

Anything other than `101` means the upgrade failed; check the three traps in order.

## Quick log analysis

```bash
# Count status codes on the WebSocket endpoint over the last 10 minutes
sudo awk -v dt="$(date -d '10 minutes ago' '+%d/%b/%Y:%H:%M')" '$4 > "[" dt' \
    /var/log/nginx/access.log | grep /ws | awk '{print $9}' | sort | uniq -c

# Look for sockets the backend cut off
sudo grep 'recv() failed.*upgraded connection' /var/log/nginx/error.log | tail
```

Expected: a large majority of `101` status codes. A high `200` rate means traps 1 or 2 are still in play; a high `400`/`403` rate points to client-side or auth issues.

## References

- nginx WebSocket docs: https://nginx.org/en/docs/http/websocket.html
- RFC 6455 (the WebSocket protocol)
- RFC 8441 (Bootstrapping WebSockets with HTTP/2)
