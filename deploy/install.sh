#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
if [[ $EUID -ne 0 || $# -ne 2 ]]; then
  echo 'Usage: install.sh <linux-binary> <deploy-public-key.pub>' >&2
  exit 64
fi
app=/opt/lilt
binary=$(realpath "$1")
public_key=$(realpath "$2")
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -r /etc/server-maintenance-host && $(< /etc/server-maintenance-host) == nas ]] || { echo 'Lilt installation targets NAS.' >&2; exit 1; }
exec 8>/run/lock/server-maintenance.lock
flock -s -n 8 || { echo 'A full backup or maintenance operation is running.' >&2; exit 75; }
exec 9>/run/lock/lilt-deploy.lock
flock -n 9 || { echo 'Another Lilt installation or release is running.' >&2; exit 75; }
for path in "$app" /etc/systemd/system/lilt.service /etc/nginx/app-locations/lilt.conf /etc/sudoers.d/lilt-deploy /opt/serverportal/registry.d/lilt.json; do
  [[ ! -e $path && ! -L $path ]] || { echo "Installation already exists: $path" >&2; exit 1; }
done
if id lilt >/dev/null 2>&1 || id lilt-deploy >/dev/null 2>&1; then echo 'Account already exists.' >&2; exit 1; fi
test -f "$binary"
[[ -x /opt/serverportal/bin/portal && -f /opt/server-context/scripts/upgrade-state.py ]]
for tool in ffmpeg ffprobe vips jq curl ss nginx ssh-keygen visudo; do command -v "$tool" >/dev/null; done
ssh-keygen -l -f "$public_key" >/dev/null
if [[ $(wc -l < "$public_key") -ne 1 ]] || ! grep -q '^ssh-ed25519 ' "$public_key"; then
  echo 'Expected one Ed25519 public key.' >&2
  exit 64
fi
[[ -z $(ss -H -ltn 'sport = :18089') ]] || { echo 'Port 18089 is in use.' >&2; exit 1; }
# The existing private Portal configuration is the source of trusted Origins.
origins=$(jq -er '.origins | if type == "array" and length > 0 and all(.[]; type == "string" and test("^https://[^/[:space:],]+$")) then join(",") else error("Expected nonempty HTTPS origins") end' /opt/serverportal/config/portal.json)
useradd --system --home-dir "$app" --shell /usr/sbin/nologin lilt
install -d -m 0755 "$app" "$app/bin" "$app/config" "$app/releases"
install -d -m 0700 -o lilt -g lilt "$app/data"
install -m 0755 "$binary" "$app/bin/lilt"
install -m 0644 "$scripts/nginx-location.conf" "$scripts/lilt.service" "$app/config/"
printf 'LILT_ORIGINS=%s\n' "$origins" > "$app/config/lilt.env"
chmod 0600 "$app/config/lilt.env"
bash "$scripts/setup-deploy.sh" "$public_key"
systemctl link "$app/config/lilt.service"
systemctl daemon-reload
systemctl enable --now lilt.service
curl --fail --silent --retry 10 --retry-delay 1 --retry-connrefused --max-time 5 http://127.0.0.1:18089/healthz
runuser -u lilt -- "$app/bin/lilt" check --data "$app/data"
ln -s "$app/config/nginx-location.conf" /etc/nginx/app-locations/lilt.conf
if ! nginx -t; then
  rm -- /etc/nginx/app-locations/lilt.conf
  echo 'Nginx validation failed; the new link was removed.' >&2
  exit 1
fi
systemctl reload nginx
echo 'Lilt installed on NAS. Publish its Portal declaration and synchronize documents next.'
