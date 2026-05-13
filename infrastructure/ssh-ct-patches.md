---
name: ssh-ct-patches
description: Safe patterns for patching source code on a remote Proxmox LXC container via SSH + pct exec without bash eating your template literals, backticks, or dollar signs.
---

# Patching Code on a Remote LXC Container

How to push code changes through `ssh -> pct exec -> python / sed` without the multiple shell layers silently eating `${...}`, backticks, or interpreted escapes. Patterns hardened from a real production incident where JavaScript template literals were mangled into broken `fetch()` calls in front-end code on deploy.

## When to use

- Hot-patching a service on an LXC container where there's no git-deploy yet
- Applying a SQLite migration on a container that doesn't have the `sqlite3` CLI
- Editing front-end source containing template literals or back-end source containing `f"..."` from a remote shell
- Recovering from a botched deploy where backticks or `${}` got stripped

For anything more complex than a hotfix, set up proper CI/CD (Gitea Actions / GitHub Actions / Argo CD) instead of patching live.

## The fundamental trap

Imagine you run:

```bash
ssh user@host "sudo pct exec <ctid> -- python3 << 'PYEOF'
src = src.replace('fetch()', 'fetch(`${API}/foo`)')
PYEOF"
```

The single-quoted `'PYEOF'` is supposed to protect the heredoc. **But there are five layers of interpretation between your keyboard and the Python process**:

1. Your local bash (the outer `ssh "..."`)
2. SSH transport (encoding)
3. Remote bash on the Proxmox host
4. The `sudo pct exec` wrapper
5. Bash inside the container

At any of those layers, an unquoted `${...}` or `` ` `` can be expanded if it isn't already inside an iron-clad quoted region. Real-world failure mode: JavaScript `fetch(\`${API}/sessions/${id}/flies\`)` lands as `fetch()` in production. Three fetches silently broken, no syntax error.

## Pattern 1: avoid template literals in the patch payload

The cheapest fix: rewrite your patch so the payload never contains backticks or `${}` in the first place.

```python
# BAD -- backticks and ${} make it through five shell layers
src = src.replace("fetch()", "fetch(`${API}/foo`)")

# GOOD -- string concatenation, robust to all shell interpolation
src = src.replace("fetch()", 'fetch(API + "/foo")')
```

The resulting JavaScript is still valid; the deploy is now bulletproof.

## Pattern 2: scp the script, then execute remotely

The safest pattern. Write the script locally, ship the file, run it server-side. No shell sees the contents.

```bash
# 1. Write the patch script locally
cat > /tmp/patch.py <<'EOF'
import re
path = '/opt/<app>/frontend/src/App.tsx'
with open(path) as f:
    src = f.read()
# Free to use any character here, the file is shipped as-is.
src = src.replace("fetch()", "fetch(`${API}/foo`)")
with open(path, 'w') as f:
    f.write(src)
EOF

# 2. scp to the Proxmox host
scp /tmp/patch.py <user>@<pve-host>:/tmp/patch.py

# 3. Push into the CT
ssh <user>@<pve-host> "sudo pct push <ctid> /tmp/patch.py /tmp/patch.py"

# 4. Run inside the CT
ssh <user>@<pve-host> "sudo pct exec <ctid> -- python3 /tmp/patch.py"
```

Backticks, `${}`, dollar-quoted strings -- everything arrives intact.

## Pattern 3: inline heredoc with manual escaping

Possible but fragile. Escape `$` as `\$` and backticks as `\\\``.

```bash
ssh <pve> "sudo pct exec <ctid> -- python3 << 'PYEOF'
src = src.replace('fetch()', 'fetch(\`\${API}/foo\`)')
PYEOF"
```

Hard to read, hard to debug. Use pattern 1 or 2 whenever possible.

## SQLite migrations without the CLI

If the CT doesn't have `sqlite3` installed (common on slim Debian images), apply migrations via Python.

```python
# /tmp/apply_migration.py
import sqlite3

con = sqlite3.connect("/opt/<app>/data/<db>.sqlite")
with open("/tmp/002_new_feature.sql") as f:
    sql = f.read()

try:
    con.executescript(sql)
    con.commit()
    print("MIGRATION_OK")
except Exception as e:
    print(f"MIGRATION_ERR: {e}")
    raise
finally:
    # Quick sanity check
    cur = con.cursor()
    for row in cur.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        print("table:", row[0])
    con.close()
```

Keep SQL in a file and read it from Python. Inlining SQL inside the Python source inside an SSH heredoc just multiplies the escaping problems.

## Always back up before patching

Before touching any file in production, snapshot it on the CT:

```bash
ssh <pve> "sudo pct exec <ctid> -- bash -c '
  cp /opt/<app>/backend/main.py        /opt/<app>/backend/main.py.pre_<feature>
  cp /opt/<app>/backend/models.py      /opt/<app>/backend/models.py.pre_<feature>
  cp /opt/<app>/data/<db>.sqlite        /opt/<app>/data/<db>.sqlite.pre_<feature>_$(date +%Y%m%d)
  echo BACKUPS_OK
'"
```

Convention: suffix `.pre_<feature>` (and add a date suffix for database files).

Rollback: copy the `.pre_*` back and restart the service.

```bash
ssh <pve> "sudo pct exec <ctid> -- bash -c '
  cp main.py.pre_<feature>   main.py
  cp models.py.pre_<feature> models.py
  systemctl restart <app>
'"
```

## Verify before restart

### Python syntax check

```python
import ast
with open(path) as f:
    src = f.read()
try:
    ast.parse(src)
    print("SYNTAX_OK")
except SyntaxError as e:
    print(f"SYNTAX_ERR: {e}")
    raise
```

Run this after every Python patch, before `systemctl restart`. Skipping it means a syntax error takes the service down on the next restart with no obvious cause in the journal.

### TypeScript build check

`npx tsc --noEmit` without a `tsconfig` reports false positives. Use the project's build command:

```bash
cd /opt/<app>/frontend && npm run build 2>&1 | tail -20
```

## Smoke-test after restart

```bash
systemctl restart <app>
sleep 2

# Did it come back up?
systemctl is-active <app>

# Anything wrong in the last 15 seconds of logs?
journalctl -u <app> --since "15 seconds ago" --no-pager | grep -iE "error|exception|traceback" | head

# Hit the health and a representative endpoint
curl -fsS http://<ct-ip>:<port>/health
curl -fsS http://<ct-ip>:<port>/api/v1/<endpoint> | head
```

## Deploy checklist via SSH patches

- [ ] Backup all touched source files with `.pre_<feature>` suffix
- [ ] Backup any modified database file with `.pre_<feature>_YYYYMMDD`
- [ ] Write the patch script locally (no inline heredocs)
- [ ] `scp` and `pct push` the script
- [ ] Run, verify the output
- [ ] `ast.parse` for Python; `npm run build` for front-end
- [ ] `systemctl restart <app>`
- [ ] `journalctl` for boot errors
- [ ] `curl` smoke-test the critical endpoints
- [ ] Document the change in a dated note (`YYYY-MM-DD_deploy.md`)

## Recurrent CT-side gotchas

- No `sqlite3` CLI on slim Debian images: use Python's `sqlite3` module
- `pip install` needs `--break-system-packages` on PEP 668-enforced installs
- `pct push` reads from the Proxmox host filesystem; `scp` first if the file is on your laptop
- Container running as `root` is convenient but tightens the blast radius -- weigh the risk
- `npm run build` must run from inside the front-end directory; the cache is per-directory

## When this skill applies

- Patching `main.py`, `App.tsx`, models, schemas on a running LXC
- Applying a migration on a CT without `sqlite3` CLI
- Service won't restart after a deploy, with no clue in the journal
- Template literals / f-strings disappeared after an SSH patch
- Investigating "why did `fetch(\`${...}/foo\`)` become `fetch()` in production?"
