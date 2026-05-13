---
name: jitsi-post-upgrade
description: "Fix the five recurring bugs that break Jitsi Meet after apt upgrade jitsi-meet: Prosody namespace symlinks, deleted focus account, HTTP/2 WebSocket breakage, Connection-header map, empty focus roster."
---

# Jitsi Meet After an Upgrade

After `apt upgrade jitsi-meet` (or a fresh install), conferences typically break with `Connection failed. Please try again.` in a loop. The fix is a chain of five small things, each of which only matters if the previous one is already correct. This skill captures the full sequence with the exact symptoms.

## Quick diagnosis

Connect to the Jitsi host and check:

```bash
# 1. All services up?
sudo systemctl is-active prosody jicofo jitsi-videobridge2 nginx

# 2. Jicofo authenticated to Prosody?
sudo grep 'focus@auth' /var/log/prosody/prosody.log | tail -3
# Expected: "Authenticated as focus@auth..."
```

From the browser console (F12) on a failing join attempt:

| Browser-side error                                     | Likely problem |
|--------------------------------------------------------|----------------|
| `service-unavailable` on `conference request (IQ)`     | Problem 5 (empty focus roster)              |
| WebSocket returns HTTP `200` instead of `101`          | Problem 3 (HTTP/2) or Problem 4 (Connection map) |
| `SASLError not-authorized`                             | Problem 2 (focus account missing)            |
| `mod_websocket` errors in `prosody.err`                | Problem 1 (Prosody namespace symlinks)       |

Walk the five fixes in order.

## Problem 1: Prosody namespace symlinks

Jitsi plugins do `require "prosody.util.queue"` but Prosody 0.12 exposes modules at the top level without the `prosody.` prefix.

```bash
sudo mkdir -p /usr/lib/prosody/prosody
sudo ln -sf /usr/lib/prosody/util    /usr/lib/prosody/prosody/util
sudo ln -sf /usr/lib/prosody/net     /usr/lib/prosody/prosody/net
sudo ln -sf /usr/lib/prosody/core    /usr/lib/prosody/prosody/core
sudo ln -sf /usr/lib/prosody/modules /usr/lib/prosody/prosody/modules
sudo systemctl restart prosody
```

Check `/var/log/prosody/prosody.err` is empty after restart.

## Problem 2: focus account deleted

The upgrade sometimes wipes the XMPP `focus` account.

```bash
# Check what's in the Prosody accounts directory
sudo ls /var/lib/prosody/auth%2e<host%2eFQDN>/accounts/
# Expected: focus.dat AND jvb.dat
```

If `focus.dat` is missing, recover the password from Jicofo's config and recreate the account:

```bash
sudo grep -E 'password|username' /etc/jitsi/jicofo/jicofo.conf

# Use the password you just read
sudo prosodyctl register focus auth.<host-fqdn> '<password>'
sudo systemctl restart jicofo
```

Verify: `/var/log/jitsi/jicofo.log` should show `Registered (resumed=false)` and no `SASLError`.

## Problem 3: HTTP/2 in nginx breaks WebSocket

nginx versions before 1.25.1 do not support WebSocket over HTTP/2 (RFC 8441 Extended CONNECT). Firefox and modern Chromium force HTTP/2 by default, so the upgrade silently fails.

```bash
sudo sed -i 's/listen 443 ssl http2;/listen 443 ssl;/' \
  /etc/nginx/sites-enabled/<host-fqdn>.conf
sudo sed -i 's|listen \[::\]:443 ssl http2;|listen [::]:443 ssl;|' \
  /etc/nginx/sites-enabled/<host-fqdn>.conf
sudo nginx -t && sudo systemctl reload nginx
```

Verify: access log shows `GET /xmpp-websocket HTTP/1.1 101`, not `HTTP/2.0 200`.

See [`nginx-websocket`](../network/nginx-websocket.md) for the three classic WebSocket-over-nginx traps.

## Problem 4: hardcoded `Connection: upgrade` with keepalive

A static `proxy_set_header Connection "upgrade"` combined with upstream `keepalive` creates conflicts on the second WebSocket from the same client.

```bash
# Create the conditional map (idempotent)
sudo tee /etc/nginx/conf.d/websocket_upgrade.conf >/dev/null <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF

# Patch the vhost
sudo sed -i 's|proxy_set_header Connection "upgrade";|proxy_set_header Connection $connection_upgrade;|g' \
  /etc/nginx/sites-enabled/<host-fqdn>.conf
sudo nginx -t && sudo systemctl reload nginx
```

## Problem 5: empty focus roster (the final boss)

The most pernicious. After `prosodyctl register focus`, the XMPP roster for the `focus` account is empty. `mod_client_proxy` sends a subscription request but never receives the `available` presence from Jicofo because the roster doesn't list the component. Result: `sessions = {}` inside the module and every IQ returns `service-unavailable`.

Exact browser symptom:

```
[xmpp:StropheErrorHandler] Strophe error: {
  "reason": "service-unavailable",
  "operation": "conference request (IQ)",
  "targetJid": "focus.<host-fqdn>"
}
```

Fix:

```bash
sudo systemctl stop jicofo

ROSTER="/var/lib/prosody/auth%2e<host%2eFQDN>/roster/focus.dat"

sudo bash -c "cat > $ROSTER" <<'EOF'
return {
    ["focus.<host-fqdn>"] = {
        ["subscription"] = "both";
        ["groups"]       = {};
    };
    [false] = {
        ["pending"] = {};
        ["version"] = 2;
    };
};
EOF

sudo chown prosody:prosody "$ROSTER"
sudo chmod 640             "$ROSTER"

sudo systemctl restart prosody
sudo systemctl start    jicofo
```

The `%2e` is a URL-encoded dot. Prosody stores per-host data using URL encoding, so a hostname `auth.foo.example.com` becomes `auth%2efoo%2eexample%2ecom`.

## Post-upgrade checklist

Run in order after any Jitsi upgrade:

- [ ] Problem 1: namespace symlinks
- [ ] Problem 2: focus account recreated if missing
- [ ] Problem 3: HTTP/2 disabled on the Jitsi vhost
- [ ] Problem 4: `Connection $connection_upgrade` map in place
- [ ] Problem 5: focus roster populated
- [ ] Restart order: `prosody` -> `jicofo` -> `jitsi-videobridge2`, then `nginx -s reload`
- [ ] `/var/log/jitsi/jicofo.log` shows Jicofo authenticated and `Joined jvbbrewery`
- [ ] Test from two different browsers: `https://<host-fqdn>/test-room`

## Server-side WebSocket smoke test

```bash
curl -sk \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Host: <host-fqdn>' \
  --http1.1 \
  -D /dev/stdout -o /dev/null \
  'https://localhost/xmpp-websocket?room=test' | head -3
# Expected: HTTP/1.1 101 Switching Protocols
```

## When this skill applies

- After `apt upgrade jitsi-meet`
- After a fresh Jitsi reinstall
- After moving the Jitsi host (Hyper-V -> Proxmox, hardware migration, etc.)
- When the user reports `Connection failed. Please try again.` in a loop on join
- When the browser console shows `service-unavailable` on a conference IQ
