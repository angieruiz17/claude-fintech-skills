---
name: auth-token-decode
description: "Decode a JWT (Entra ID, Auth0, Cognito, etc.) without any library, using base64 + json only. Useful for diagnosing aud / iss / exp / scopes from a console screenshot or pasted token."
---

# Decode a JWT by Hand

Quick helper to decode a JSON Web Token (JWT) without any library, using only base64 and Python's standard json. Useful for:

- Diagnosing a `401 Unauthorized` on a custom back-end (verify `aud`, `iss`, `exp`)
- Inspecting the claims / roles / scopes assigned to a user in Entra ID, Auth0, or Cognito
- Understanding why MSAL handed back a Graph access token instead of one for your API
- Confirming a token actually comes from the expected tenant

## JWT structure

`<header>.<payload>.<signature>`: three base64url-encoded parts separated by dots.

- **Header**: algorithm (e.g. RS256), `kid` (key ID for JWKS lookup), `typ` (JWT)
- **Payload**: the claims (`aud`, `iss`, `exp`, `sub`, `email`, `roles`, `scp`, ...)
- **Signature**: cryptographic verification via the JWKS public key

In practice you decode the **payload only**. The header is rarely interesting; verifying the signature requires fetching the JWKS, which we skip here.

## One-liner decoders

### Bash + Python

```bash
TOKEN="eyJ0eXAi..."
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
```

Standard base64 refuses non-padded input. JWT uses base64url **without** padding. Workaround:

```bash
TOKEN="eyJ..."
PAYLOAD=$(echo "$TOKEN" | cut -d. -f2)
PADDED="$PAYLOAD$(printf '=%.0s' $(seq 1 $((4 - ${#PAYLOAD} % 4))))"
echo "$PADDED" | base64 -d 2>/dev/null | python3 -m json.tool
```

### Pure-Python one-liner

```bash
python3 -c "
import sys, base64, json
t = sys.argv[1].split('.')[1]
print(json.dumps(
    json.loads(base64.urlsafe_b64decode(t + '=' * (4 - len(t) % 4))),
    indent=2, default=str))
" "eyJ..."
```

### Reusable script

```python
import base64, json, sys

def decode_jwt(token: str) -> dict | None:
    parts = token.split('.')
    if len(parts) != 3:
        return None
    payload = parts[1]
    payload += '=' * (4 - len(payload) % 4)   # pad to multiple of 4
    return json.loads(base64.urlsafe_b64decode(payload))

if __name__ == '__main__':
    claims = decode_jwt(sys.argv[1])
    print(json.dumps(claims, indent=2, default=str))
```

Usage: `python3 decode_jwt.py "eyJ..."`.

## Claims that matter, per provider

### Entra ID (Microsoft, Azure AD)

| Claim                  | What to check                                                          |
|------------------------|------------------------------------------------------------------------|
| `aud`                  | Matches your API's `CLIENT_ID` (or `api://CLIENT_ID/...`)              |
| `iss`                  | `https://login.microsoftonline.com/{tenant}/v2.0` or `/sts.windows.net/{tenant}/` |
| `tid`                  | Tenant ID matches the one you expect                                   |
| `appid`                | Client app ID that acquired the token                                  |
| `oid`                  | Unique user object ID in Entra                                         |
| `preferred_username`   | User's email                                                           |
| `name`                 | Display name                                                           |
| `roles`                | App roles assigned (`["admin"]`, `["broker"]`, ...)                    |
| `scp`                  | Delegated scopes (`User.Read profile openid email`)                    |
| `exp`, `iat`, `nbf`    | Unix timestamps                                                        |
| `ver`                  | `1.0` or `2.0` (v2 = OAuth2 / OIDC standard)                           |

**Graph access token** (the wrong one for your API):

```json
{
  "aud": "00000003-0000-0000-c000-000000000046",
  "iss": "https://sts.windows.net/{tenant}/",
  "scp": "User.Read profile openid email"
}
```

If `aud = 00000003-0000-0000-c000-000000000046`, it's a **Microsoft Graph** token, not for your API. Use `idToken` (whose `aud` is your `CLIENT_ID`) instead of `accessToken`.

**ID token** (typical for back-ends that just need user identity):

```json
{
  "aud": "<your-app-client-id>",
  "iss": "https://login.microsoftonline.com/{tenant}/v2.0",
  "preferred_username": "user@example.com",
  "roles": ["broker"]
}
```

**Custom API access token** (when you've exposed a scope `api://<client>/access_as_user`):

```json
{
  "aud": "api://<your-app-client-id>",
  "scp": "access_as_user"
}
```

### Auth0

| Claim   | Meaning                                  |
|---------|------------------------------------------|
| `aud`   | API audience (URL or identifier)         |
| `iss`   | `https://{tenant}.auth0.com/`            |
| `sub`   | User ID (`auth0|...`)                    |
| `gty`   | Grant type                               |

### Cognito (AWS)

| Claim                | Meaning                                                       |
|----------------------|---------------------------------------------------------------|
| `aud`                | App client ID                                                 |
| `iss`                | `https://cognito-idp.{region}.amazonaws.com/{user-pool-id}`   |
| `cognito:groups`     | Groups assigned                                               |
| `cognito:username`   | Username                                                      |

## Grabbing a JWT from a browser

### F12 network tab

1. Open F12 -> Network
2. Trigger an action that calls your API (refresh, click)
3. Pick any request, open Headers -> Request Headers
4. Copy the value of `Authorization: Bearer eyJ...` (drop the `Bearer ` prefix)

### MSAL session storage

1. F12 -> Application -> Storage -> Session Storage
2. Pick the right domain
3. Look for keys with names like:
   - `msal.account.keys`
   - `msal.token.keys.{clientId}`
   - Access tokens: `<homeAccountId>-login.windows.net-accesstoken-{clientId}-...`
   - ID tokens:     `<homeAccountId>-login.windows.net-idtoken-{clientId}-...`
4. The value is a JSON; its `secret` field holds the JWT.

### Console one-liner (MSAL.js v2)

```js
// List cached access tokens with audience and expiry
Object.keys(sessionStorage)
  .filter(k => k.includes('accesstoken'))
  .forEach(k => {
    const v = JSON.parse(sessionStorage.getItem(k));
    console.log('AT:', v.target, '| aud:', v.realm,
                '| expires:', new Date(v.expiresOn * 1000).toISOString());
  });

// And ID tokens with the first 50 chars of the JWT
Object.keys(sessionStorage)
  .filter(k => k.includes('idtoken'))
  .forEach(k => {
    const v = JSON.parse(sessionStorage.getItem(k));
    console.log('ID:', k.split('-').pop(),
                '| token:', v.secret.substring(0, 50) + '...');
  });
```

## Check expiry quickly

```bash
EXP=1730454321
# macOS
date -r "$EXP"
# Linux
date -d @"$EXP"

# How much time left
echo "$(( EXP - $(date +%s) )) seconds left"
```

- `exp - now < 0`: token expired: silent refresh should have kicked in
- `0 < exp - now < 300`: about to expire, wait for refresh

## When to use this skill

- Unexplained `401 Unauthorized` on a back-end that validates JWTs
- User reports "I'm logged in but it doesn't work"
- After a sign-out / sign-in cycle that didn't fix the issue
- To confirm a token really is expired before blaming silent refresh
- To distinguish an ID token from an access token from a Graph token when the back-end validates a specific audience
