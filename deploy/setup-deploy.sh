#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
if [[ $EUID -ne 0 || $# -ne 1 ]]; then
  printf 'Usage: sudo bash deploy/setup-deploy.sh <deploy-public-key.pub>\n' >&2
  exit 64
fi
[[ -r /etc/server-maintenance-host && $(< /etc/server-maintenance-host) == nas ]] || { echo 'Lilt deployment setup targets NAS.' >&2; exit 1; }
public_key=$(realpath "$1")
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ssh-keygen -l -f "$public_key" >/dev/null
if [[ $(wc -l < "$public_key") -ne 1 ]] || ! grep -q '^ssh-ed25519 ' "$public_key"; then
  printf 'Expected one Ed25519 public key.\n' >&2
  exit 64
fi
test -x /opt/lilt/bin/lilt
if id lilt-deploy >/dev/null 2>&1 || [[ -e /etc/sudoers.d/lilt-deploy || -L /etc/sudoers.d/lilt-deploy ]]; then
  printf 'Deployment user already exists; rotate its key explicitly instead of rerunning setup.\n' >&2
  exit 1
fi
useradd --system --home-dir /opt/lilt/deploy-user --shell /bin/bash lilt-deploy
# Root ownership keeps the key restrictions and fixed scripts immutable to this identity.
install -d -m 0755 /opt/lilt/deploy-user /opt/lilt/deploy-user/.ssh
install -m 0755 "$scripts/deploy-ssh.sh" /opt/lilt/bin/deploy-ssh.sh
install -m 0755 "$scripts/deploy-release.sh" /opt/lilt/bin/deploy-release.sh
printf 'restrict,command="/opt/lilt/bin/deploy-ssh.sh" %s\n' "$(< "$public_key")" > /opt/lilt/deploy-user/.ssh/authorized_keys
chmod 0644 /opt/lilt/deploy-user/.ssh/authorized_keys
printf 'lilt-deploy ALL=(root) NOPASSWD: /opt/lilt/bin/deploy-release.sh\n' > /etc/sudoers.d/lilt-deploy
chmod 0440 /etc/sudoers.d/lilt-deploy
visudo -cf /etc/sudoers.d/lilt-deploy
printf 'Restricted Lilt deployment user configured.\n'
