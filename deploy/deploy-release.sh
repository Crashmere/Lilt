#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

if [[ $EUID -eq 0 && $# -eq 3 && ( $1 == portal || $1 == portal-check ) && $2 =~ ^[0-9a-f]{40}$ && $3 =~ ^[0-9a-f]{64}$ ]]; then
  portal_action=register
  if [[ $1 == portal-check ]]; then portal_action=check-registration; fi
  exec timeout 45 /opt/serverportal/bin/portal "$portal_action" --app lilt --commit "$2" --sha256 "$3"
fi

if [[ $EUID -ne 0 || $# -lt 2 || $# -gt 3 || ! $1 =~ ^[0-9a-f]{40}$ || ! $2 =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Usage: deploy-release.sh <commit> <sha256> [database-plan] < binary' >&2
  exit 64
fi
commit=$1
expected=$2
plan_token=${3:-}
if [[ -n $plan_token && ( ! $plan_token =~ ^[A-Za-z0-9_-]+$ || ${#plan_token} -gt 4096 ) ]]; then
  echo 'Invalid database protection plan.' >&2
  exit 64
fi
app=/opt/lilt
upgrade=/opt/server-context/scripts/upgrade-state.py
[[ -r /etc/server-maintenance-host && $(< /etc/server-maintenance-host) == nas ]] || { echo 'Lilt releases target NAS.' >&2; exit 1; }
test -f "$upgrade"
exec 8>/run/lock/server-maintenance.lock
flock -s -n 8 || { echo 'A full backup or maintenance operation is running.' >&2; exit 75; }
exec 9>/run/lock/lilt-deploy.lock
flock -n 9 || { echo 'Another Lilt release is running.' >&2; exit 75; }
test -f "$app/data/lilt.sqlite"
test -x "$app/bin/lilt"
release=$(mktemp -d "$app/releases/$commit.XXXXXX")
chmod 0755 "$release"
stopped=false
replaced=false
healthy() {
  systemctl is-active --quiet lilt &&
    curl --fail --silent --max-time 3 http://127.0.0.1:18089/healthz | grep -q '"status":"ok"' &&
    curl --fail --silent --max-time 3 http://127.0.0.1/lilt/ | grep -q '/lilt/assets/'
}
wait_healthy() {
  for ((attempt=0;attempt<20;attempt++)); do
    if healthy; then return 0; fi
    sleep 1
  done
  return 1
}
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  recovery_status=not-needed
  if [[ $result -ne 0 && $stopped == true ]]; then
    recovery_status=failed
    systemctl stop lilt || true
    if [[ $replaced == true ]]; then
      install -m 0755 "$release/previous" "$app/bin/lilt.rollback"
      mv -f "$app/bin/lilt.rollback" "$app/bin/lilt"
      if [[ -f $release/previous-commit ]]; then
        install -m 0644 "$release/previous-commit" "$app/current-commit"
      elif [[ -f $app/current-commit ]]; then
        rm -- "$app/current-commit"
      fi
    fi
    if systemctl start lilt && wait_healthy; then
      recovery_status=healthy
      echo 'Previous program is healthy; data was not rolled back.' >&2
    else
      echo 'ROLLBACK FAILED: inspect journalctl -u lilt.' >&2
    fi
  fi
  printf '%s\n' "$recovery_status" > "$release/recovery"
  if [[ $result -eq 0 ]]; then echo success > "$release/result"; else echo failed > "$release/result"; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
timeout 90 head -c 67108865 > "$release/lilt"
size=$(stat -c %s "$release/lilt")
if ((size == 0 || size > 67108864)); then echo 'Binary size must be 1 byte to 64 MiB.' >&2; exit 65; fi
actual=$(sha256sum "$release/lilt")
if [[ ${actual%% *} != "$expected" ]]; then echo 'Checksum mismatch.' >&2; exit 65; fi
chmod 0755 "$release/lilt"
cp "$app/bin/lilt" "$release/previous"
chmod 0755 "$release/previous"
if [[ -f $app/current-commit ]]; then cp "$app/current-commit" "$release/previous-commit"; fi
printf 'commit=%s\nsha256=%s\n' "$commit" "$expected" > "$release/metadata"
stopped=true
systemctl stop lilt
candidate_data=$(python3 "$upgrade" begin --app lilt --release "$(basename "$release")" --plan-token "$plan_token")
backup="/var/lib/server-upgrades/lilt/$(basename "$release")"
runuser -u lilt -- timeout 60 "$release/lilt" check --data "$candidate_data"
install -m 0755 "$release/lilt" "$app/bin/lilt.next"
replaced=true
mv -f "$app/bin/lilt.next" "$app/bin/lilt"
systemctl start lilt
wait_healthy
if [[ -d $backup ]]; then
  systemctl stop lilt
  python3 "$upgrade" verify --app lilt --release "$(basename "$release")"
  systemctl start lilt
  wait_healthy
fi
printf '%s\n' "$commit" > "$app/current-commit"
chmod 0644 "$app/current-commit"
python3 "$upgrade" accept --app lilt --release "$(basename "$release")"
printf 'Deployed Lilt %s.\n' "$commit"
