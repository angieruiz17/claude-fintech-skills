---
name: pve-cluster-join
description: "Join a new node to an existing Proxmox VE cluster: the four traps that block pvecm add (TFA on root, missing SSH keys between roots, /etc/hosts entries, SSH root config), tested sequence and verification."
---

# Join a Node to a Proxmox VE Cluster

Procedure to add a new Proxmox host to an existing cluster. The Proxmox docs explain `pvecm add` in three lines; this skill captures the four pitfalls that make those three lines fail in real life.

## Prerequisites

- New node installed with Proxmox VE 8, hardened (see [`proxmox-host-hardening`](https://github.com/fawraw/proxmox-host-hardening) if you want a starting point)
- SSH access to both nodes via your dedicated low-privilege user
- Root SSH access on both nodes (key-based) for the initial cluster bootstrap

## The four traps

| Trap                                       | Symptom                                          | Fix                                                              |
|--------------------------------------------|--------------------------------------------------|------------------------------------------------------------------|
| Two-factor auth on `root@pam`              | `pvecm add` exits with HTTP 401                  | Temporarily remove `root@pam` from `/etc/pve/priv/tfa.cfg`       |
| Root SSH keys not exchanged                | `unable to copy ssh ID` from `pvecm add --use_ssh` | Pre-deploy each node's root pubkey into the other's `authorized_keys` |
| Missing entries in `/etc/hosts`            | DNS resolution fails mid-join                    | Add both hostnames on both nodes                                 |
| `PermitRootLogin no` in `sshd_config`      | Cluster needs root SSH between nodes             | Use `prohibit-password` (key-only), keep `root` in `AllowUsers`  |

## Step 1: temporarily disable TFA on `root@pam` (master only)

`pvecm add` authenticates as root via the API. If `root@pam` has TFA enabled, you cannot complete the join without an interactive code, and the script doesn't have a way to provide it.

```bash
# On the master node
sudo cp /etc/pve/priv/tfa.cfg /etc/pve/priv/tfa.cfg.bak

sudo python3 - <<'PY'
import json, pathlib
p = pathlib.Path('/etc/pve/priv/tfa.cfg')
data = json.loads(p.read_text())
if 'root@pam' in data.get('users', {}):
    del data['users']['root@pam']
    p.write_text(json.dumps(data))
    print('root@pam TFA removed temporarily')
PY

sudo systemctl restart pvedaemon pveproxy
```

Restore at the end (step 7).

## Step 2: add `/etc/hosts` entries on both nodes

Cluster bootstrap does hostname lookups before quorum is established. Don't rely on DNS.

```bash
# On the master
grep -q 'newnode' /etc/hosts || \
  echo '<new-node-ip> newnode.<domain> newnode' | sudo tee -a /etc/hosts

# On the new node
grep -q 'master' /etc/hosts || \
  echo '<master-ip> master.<domain> master' | sudo tee -a /etc/hosts
```

## Step 3: exchange root SSH keys

```bash
# Generate the new node's root RSA key if it isn't there yet
sudo test -f /root/.ssh/id_rsa.pub || \
  sudo ssh-keygen -t rsa -b 4096 -f /root/.ssh/id_rsa -N '' -q

# Push the new node's root pubkey to the master's authorized_keys
NEW_PUB=$(sudo cat /root/.ssh/id_rsa.pub)
ssh <master> "echo '$NEW_PUB' | sudo tee -a /root/.ssh/authorized_keys >/dev/null"

# Push the master's root pubkey to the new node's authorized_keys
ssh <master> "sudo cat /root/.ssh/id_rsa.pub" | \
  sudo tee -a /root/.ssh/authorized_keys >/dev/null

# Pre-accept host keys both ways
sudo ssh -o StrictHostKeyChecking=no -o BatchMode=yes root@<master> hostname
ssh <master> "sudo ssh -o StrictHostKeyChecking=no -o BatchMode=yes root@<new-node> hostname"
```

## Step 4: create the cluster if it doesn't exist

Only needed on the very first node:

```bash
sudo pvecm create <cluster-name>
# If corosync complains:
sudo systemctl restart corosync pve-cluster
```

## Step 5: join

From the new node:

```bash
sudo pvecm add <master-ip> --use_ssh true
```

Expected output:

```
No cluster network links passed explicitly, fallback to local node IP '<new-node-ip>'
copy corosync auth key
stopping pve-cluster service
backup old database to '/var/lib/pve-cluster/backup/config-XXXXXXXXXX.sql.gz'
waiting for quorum...OK
(re)generate node files
generate new node certificate
merge authorized SSH keys
generated new node certificate, restart pveproxy and pvedaemon services
successfully added node '<new-node>' to cluster.
```

If you see `unable to copy ssh ID`, go back to step 3.
If you see `401`, go back to step 1.

## Step 6: verify

```bash
sudo pvecm status
sudo pvecm nodes
```

Expected:

- `Quorate: Yes`
- `Nodes: N` (matches reality)
- Every node has `1` vote

## Step 7: restore TFA on the master

```bash
sudo cp /etc/pve/priv/tfa.cfg.bak /etc/pve/priv/tfa.cfg
sudo systemctl restart pvedaemon pveproxy
```

## Step 8: shared storage on the new node

Once the new node is in the cluster, it inherits `/etc/pve/storage.cfg` automatically. NFS mounts come up by themselves. For iSCSI multipath or other storage that requires server-side ACLs (igroup, target ACLs), grant access to the new node's IQN / IP first, then check:

```bash
sudo pvesm status
```

All shared storage entries should be `active`.

## Remove a node (rare)

From any **remaining** node:

```bash
sudo pvecm delnode <leaving-node>
sudo rm -rf /etc/pve/nodes/<leaving-node>     # cleanup
```

Repeat the directory cleanup on every remaining node.

## When this skill applies

- Adding a new Proxmox host to an existing cluster
- Onboarding a replacement node after a hardware swap
- Rebuilding a cluster from scratch after a major incident
- Diagnosing a `pvecm add` that fails with 401, SSH error, or DNS error
