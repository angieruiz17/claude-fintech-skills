---
name: msal-entra-patterns
description: "Patterns to integrate Microsoft Entra ID (Azure AD) into a React + FastAPI stack: MSAL.js v4 config, role-based access, silent token refresh, JWT validation server-side, WebSocket auth."
---

# MSAL + Entra ID Patterns

Reference for wiring Microsoft Entra ID into a single-page app on React with a FastAPI back-end. Covers the parts that the official Microsoft docs leave half-explained: MSAL v4 breaking changes, role-based access from `idTokenClaims`, silent token refresh, server-side JWT validation, WebSocket authentication.

## Tenant and app registration

Each app gets its own **App Registration** under the Entra ID tenant:

- One Client ID (Application ID)
- Optional: an exposed API scope (`api://<client-id>/access_as_user`)
- App roles (typically `admin`, `broker`, `trader`, or whatever suits your domain)
- Redirect URIs for the SPA (`https://<host>/auth/callback`)

## Frontend: `@azure/msal-react`

### Install

```bash
npm install @azure/msal-browser @azure/msal-react
```

### `authConfig.ts`

```typescript
import { Configuration } from '@azure/msal-browser';

const TENANT_ID = '<your-tenant-guid>';
const CLIENT_ID = '<app-client-id>';

export const msalConfig: Configuration = {
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    redirectUri: `${window.location.origin}/auth/callback`,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',   // per-tab. localStorage leaks across tabs
  },
};

export const loginRequest = {
  scopes: ['openid', 'profile', 'email', 'User.Read'],
};
```

### MSAL v4 breaking changes that catch everyone

MSAL.js v4 removed properties that v2/v3 tolerated. If you have legacy code:

| Property                       | Status in v4  | Fix          |
|--------------------------------|---------------|--------------|
| `navigateToLoginRequestUrl`    | removed       | delete it    |
| `storeAuthStateInCookie`       | removed       | delete it    |

Both raise TypeScript `TS2353` ("Object literal may only specify known properties").

### `main.tsx` (MsalProvider)

```typescript
import { PublicClientApplication, EventType } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';

const msalInstance = new PublicClientApplication(msalConfig);

const accounts = msalInstance.getAllAccounts();
if (accounts.length > 0) msalInstance.setActiveAccount(accounts[0]);

msalInstance.addEventCallback((event) => {
  if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
    msalInstance.setActiveAccount((event.payload as { account: AccountInfo }).account);
  }
});

// Wrap your app
<MsalProvider instance={msalInstance}>
  <App />
</MsalProvider>
```

### Hooks in components

```typescript
const { instance: msalInstance, accounts } = useMsal();
const isAuthenticated = useIsAuthenticated();
const account = useAccount(accounts[0] || {});

// Roles from idTokenClaims (NOT from accessToken in most setups)
const roles = (account?.idTokenClaims as { roles?: string[] })?.roles ?? [];
const isBroker = roles.includes('broker') || roles.includes('admin');

// Acquire access token silently, with interactive fallback
msalInstance
  .acquireTokenSilent({ ...loginRequest, account })
  .then((r) => setAccessToken(r.accessToken))
  .catch((e) => {
    if (e instanceof InteractionRequiredAuthError) {
      return msalInstance
        .acquireTokenPopup(loginRequest)
        .then((r) => setAccessToken(r.accessToken));
    }
    throw e;
  });
```

### Login and logout

```typescript
msalInstance.loginRedirect(loginRequest);   // redirect-based, cleanest UX
msalInstance.logoutRedirect();
```

`loginPopup()` works too but breaks on some browsers and inside iframes (Excel add-ins, Teams). Prefer `loginRedirect()` unless you have a specific reason.

## Backend: FastAPI + `python-jose`

### Install

```bash
pip install "python-jose[cryptography]"
```

### Token validation

```python
import urllib.request
import json
import time
from jose import jwt, JWTError

TENANT_ID = "<your-tenant-guid>"
CLIENT_ID = "<app-client-id>"
JWKS_URI = f"https://login.microsoftonline.com/{TENANT_ID}/discovery/v2.0/keys"
ISSUER   = f"https://login.microsoftonline.com/{TENANT_ID}/v2.0"

_jwks_cache = {"keys": None, "fetched_at": 0}
_JWKS_TTL = 3600   # 1 hour

def _get_jwks() -> dict:
    if time.time() - _jwks_cache["fetched_at"] > _JWKS_TTL:
        with urllib.request.urlopen(JWKS_URI, timeout=5) as r:
            _jwks_cache["keys"] = json.load(r)
            _jwks_cache["fetched_at"] = time.time()
    return _jwks_cache["keys"]

def validate_token(token: str) -> dict:
    """Return claims if valid, raise jose.JWTError otherwise."""
    jwks = _get_jwks()
    header = jwt.get_unverified_header(token)
    rsa_key = next((k for k in jwks["keys"] if k["kid"] == header["kid"]), None)
    if rsa_key is None:
        raise JWTError("Unknown key id")
    return jwt.decode(
        token,
        rsa_key,
        algorithms=["RS256"],
        audience=CLIENT_ID,
        issuer=ISSUER,
    )
```

### FastAPI dependency

```python
from fastapi import Header, HTTPException, Depends

def require_authenticated(authorization: str = Header(default="")) -> dict:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Authentication required")
    token = authorization.removeprefix("Bearer ")
    try:
        return validate_token(token)
    except JWTError as e:
        raise HTTPException(401, f"Invalid token: {e}")

@app.get("/me")
def me(user: dict = Depends(require_authenticated)):
    return {"email": user.get("preferred_username"), "roles": user.get("roles", [])}
```

### Role-based access

```python
def require_role(role: str):
    def _checker(user: dict = Depends(require_authenticated)) -> dict:
        if role not in user.get("roles", []) and "admin" not in user.get("roles", []):
            raise HTTPException(403, f"Role '{role}' required")
        return user
    return _checker

@app.post("/admin/sessions")
def create_session(user: dict = Depends(require_role("broker"))):
    ...
```

### WebSocket authentication

WebSockets don't carry HTTP headers after the upgrade handshake. Send the token in the first message:

```python
from fastapi import WebSocket, WebSocketDisconnect

@app.websocket("/ws/{session_id}")
async def ws(websocket: WebSocket, session_id: str):
    await websocket.accept()
    first = await websocket.receive_json()
    if first.get("type") != "auth":
        await websocket.close(code=4401)
        return
    try:
        user = validate_token(first["token"])
    except JWTError:
        await websocket.close(code=4401)
        return
    # user["preferred_username"], user["roles"] available here
    ...
```

## App roles in the Entra ID portal

Define in **Azure Portal > App Registrations > `<your app>` > App roles**:

```
admin   : Full administrative access
broker  : Controls negotiation sessions
trader  : Places and cancels orders
```

Assign in **Enterprise Applications > `<your app>` > Users and groups**.

Roles show up in the JWT as:

```json
{ "roles": ["broker"] }
```

## ID token vs access token vs Graph token

The single most common debugging confusion. MSAL hands back **three different tokens**:

| Token type          | `aud`                                         | What it's for                                |
|---------------------|-----------------------------------------------|----------------------------------------------|
| ID token            | your app `client_id`                          | User identity, roles: read from `idTokenClaims` in React |
| Access token (API)  | `api://<client_id>` (custom scope)            | Calling **your own API** with custom scope   |
| Access token (Graph)| `00000003-0000-0000-c000-000000000046`        | Calling Microsoft Graph                      |

A back-end that validates `audience=CLIENT_ID` will reject the Graph token with a 401. See [`auth-token-decode`](../security/auth-token-decode.md) to identify which token you're holding.

## Common pitfalls

| Symptom                                            | Probable cause                                                  |
|----------------------------------------------------|-----------------------------------------------------------------|
| 401 from back-end despite a valid Entra login      | Front-end is sending the Graph access token, not the ID token   |
| Roles array is empty                               | App roles are defined but not **assigned** to the user / group  |
| Silent token refresh fails after idle              | `InteractionRequiredAuthError`: catch it, fall back to popup    |
| Redirect loops on `/auth/callback`                 | Redirect URI mismatch between Azure portal and the SPA          |
| TS2353 on `navigateToLoginRequestUrl` etc.         | MSAL.js v4 removed those properties: delete from `authConfig` |

## When this skill applies

- Adding Entra ID auth to a new SPA + back-end
- Migrating MSAL.js from v2 / v3 to v4
- Debugging a 401 on a back-end that validates JWTs
- Adding role-based access to a FastAPI service
- Authenticating a WebSocket connection with Entra ID
