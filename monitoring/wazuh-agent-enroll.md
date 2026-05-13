---
name: wazuh-agent-enroll
description: "Enrol a Wazuh 4.x agent on a Linux host with password authentication, version pinning, group assignment, and the six recurrent enrolment pitfalls (duplicate name, version mismatch, authd password permissions, hold against apt upgrades)."
---

# Wazuh Agent Enrolment

Procedure to install a Wazuh agent on a Linux host and enrol it against an existing Wazuh manager. The Wazuh docs cover the happy path; this skill covers what happens when it goes wrong, which is most of the time on a real fleet.

## Prerequisites

- Wazuh manager reachable on TCP 1514 / 1515 (`wazuh-agentd` / `wazuh-authd`)
- Enrolment password if the manager uses authd authentication (recommended)
- Pinned version of the agent that matches the manager (agent <= manager, never greater)

## The six pitfalls

| Pitfall                                       | Fix                                                                |
|-----------------------------------------------|--------------------------------------------------------------------|
| Agent version > manager version               | Pin: `wazuh-agent=<manager-version>-1`, then `apt-mark hold`       |
| Missing `curl` / `gnupg` on minimal Debian    | `apt install -y curl gnupg` before adding the repo                 |
| Duplicate agent name on the manager           | DELETE the existing agent via API, then re-enrol                   |
| `authd.pass` has wrong ownership / mode       | `chown root:wazuh`, `chmod 640`                                    |
| `WAZUH_MANAGER` env var not applied to config | Verify `<address>` in `/var/ossec/etc/ossec.conf`, `sed` if needed |
| `apt upgrade` bumps the agent past the manager| `apt-mark hold wazuh-agent` survives upgrades                      |

## Install + enrol (Debian / Ubuntu)

```bash
# 1. Prerequisites (minimal Debian images often lack these)
sudo apt install -y curl gnupg

# 2. Add the Wazuh repo
curl -s https://packages.wazuh.com/key/GPG-KEY-WAZUH | \
  sudo gpg --dearmor -o /usr/share/keyrings/wazuh.gpg
echo "deb [signed-by=/usr/share/keyrings/wazuh.gpg] https://packages.wazuh.com/4.x/apt/ stable main" \
  | sudo tee /etc/apt/sources.list.d/wazuh.list
sudo apt update

# 3. Install pinned to match the manager version
sudo DEBIAN_FRONTEND=noninteractive WAZUH_MANAGER="<manager-ip>" \
  apt install -y -o Dpkg::Options::='--force-confnew' \
  wazuh-agent=<manager-version>-1

# 4. Hold to block apt upgrade from breaking the version pin
sudo apt-mark hold wazuh-agent

# 5. Password enrolment (if your manager uses authd password)
echo "<authd-password>" | sudo tee /var/ossec/etc/authd.pass >/dev/null
sudo chown root:wazuh /var/ossec/etc/authd.pass
sudo chmod 640         /var/ossec/etc/authd.pass

# 6. Start
sudo systemctl daemon-reload
sudo systemctl enable --now wazuh-agent
```

The `<authd-password>` is on the manager at `/var/ossec/etc/authd.pass`.

## Verify

### Agent side

```bash
sleep 10
sudo /var/ossec/bin/wazuh-control status | head -5
# Expected: wazuh-agentd is running...

sudo tail -10 /var/ossec/logs/ossec.log
# Look for: "Valid key created" and "Connected to enrollment service"
```

### Manager side

```bash
sudo /var/ossec/bin/agent_control -l 2>/dev/null | grep <HOSTNAME>
# Expected: ID: <NNN>, Name: <HOSTNAME>, IP: any, Active
```

## Group assignment

Typical groupings:

| Group           | Use                                                    |
|-----------------|--------------------------------------------------------|
| `linux-servers` | All Linux hosts (extended FIM on SSH / sudo / cron)    |
| `docker-hosts`  | Hosts running Docker (extends FIM on container runtime)|
| `hypervisor`    | Proxmox / VMware hypervisors                           |

```bash
# On the manager
echo y | sudo /var/ossec/bin/agent_groups -a -i <AGENT_ID> -g linux-servers
echo y | sudo /var/ossec/bin/agent_groups -a -i <AGENT_ID> -g <secondary-group>
```

The `echo y |` is mandatory: the command prompts for confirmation even in non-interactive contexts.

Restart the agent so it pulls the group config:

```bash
sudo systemctl restart wazuh-agent
```

## Troubleshooting

### `Duplicate agent name`

```
ERROR: Duplicate agent name: <HOSTNAME>
ERROR: Unable to add agent
```

The manager already has an agent with that name (typically left over from a previous install or hostname collision). Remove the stale record via the API:

```bash
# On the manager
TOKEN=$(sudo curl -sk -u <api-user>:<api-pw> -X POST \
  'https://<manager>:55000/security/user/authenticate?raw=true')

sudo curl -sk -X DELETE \
  "https://<manager>:55000/agents?agents_list=<AGENT_ID>&status=all" \
  -H "Authorization: Bearer $TOKEN"
```

Then on the agent, clear `client.keys` and restart:

```bash
sudo systemctl stop wazuh-agent
sudo rm -f /var/ossec/etc/client.keys
sudo touch  /var/ossec/etc/client.keys
sudo chown root:wazuh /var/ossec/etc/client.keys
sudo chmod 640        /var/ossec/etc/client.keys
sudo systemctl start wazuh-agent
```

### `No authentication password provided`

The `authd.pass` file isn't readable by `wazuh-authd`. Check ownership and content:

```bash
sudo ls -la /var/ossec/etc/authd.pass
# Expected: -rw-r----- root:wazuh
sudo cat /var/ossec/etc/authd.pass
# Should contain your enrolment password
```

Fix:

```bash
echo "<authd-password>" | sudo tee /var/ossec/etc/authd.pass
sudo chown root:wazuh /var/ossec/etc/authd.pass
sudo chmod 640        /var/ossec/etc/authd.pass
sudo systemctl restart wazuh-agent
```

### `Agent version must be lower or equal to manager version`

You installed an agent version higher than the manager (typical after `apt upgrade`).

```bash
sudo apt install --allow-downgrades --allow-change-held-packages \
  wazuh-agent=<manager-version>-1
sudo apt-mark hold wazuh-agent
```

### `WAZUH_MANAGER` env var didn't take effect

The post-install script doesn't always pick up the env var. Check the running config:

```bash
sudo grep -A1 '<address>' /var/ossec/etc/ossec.conf
# If you see <address>MANAGER_IP</address> instead of the real IP:
sudo sed -i 's/MANAGER_IP/<manager-ip>/g' /var/ossec/etc/ossec.conf
sudo systemctl restart wazuh-agent
```

## Decommissioning an agent

```bash
# On the manager: remove from the registry
TOKEN=$(sudo curl -sk -u <api-user>:<api-pw> -X POST \
  'https://<manager>:55000/security/user/authenticate?raw=true')
sudo curl -sk -X DELETE \
  "https://<manager>:55000/agents?agents_list=<AGENT_ID>&status=all" \
  -H "Authorization: Bearer $TOKEN"

# On the agent: remove the package and state
sudo apt-mark unhold wazuh-agent
sudo apt purge -y wazuh-agent
sudo rm -rf /var/ossec
```

## When this skill applies

- New host onboarded that needs FIM, log collection, and security event forwarding
- Agent stopped reporting after an `apt upgrade` (likely version mismatch)
- Hostname collision after a rename or rebuild
- Decommissioning a host and cleaning up the manager registry
