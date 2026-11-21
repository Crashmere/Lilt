#!/usr/bin/env python3
"""Add Lilt's isolated gateway forwards and registered recovery coverage."""

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess


ROOT = Path(__file__).resolve().parents[1]
SHARED = Path(os.environ.get("SERVER_OPERATIONS_HOME", str(Path.home() / "agent-config/skills/server-operations")))


def remote(host, source, payload):
    subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host,
         "python3 -c " + shlex.quote(source)],
        input=json.dumps(payload), text=True, check=True, timeout=180,
    )


ATOMIC = r'''
import json, os, pathlib, stat, subprocess, sys, tempfile
payload = json.load(sys.stdin)
if os.geteuid() != 0:
    raise SystemExit("Administrator SSH identity required")

def command(*args, check=True):
    result = subprocess.run(args, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError("Command failed: " + " ".join(args) + "\n" + result.stderr[-3000:])
    return result

def put(path, value, mode=0o644):
    path = pathlib.Path(path)
    before = path.stat() if path.exists() else None
    fd, temporary = tempfile.mkstemp(prefix=".lilt-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(value if isinstance(value, bytes) else value.encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(before.st_mode) if before else mode)
        if before:
            os.chown(temporary, before.st_uid, before.st_gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
'''


GATEWAY = ATOMIC + r'''
import pwd, re
scope = "127.0.0.1:18089"
dropin = pathlib.Path("/etc/ssh/sshd_config.d/30-nas-tunnel.conf")
home = pathlib.Path(pwd.getpwnam("nas-tunnel").pw_dir)
keys = home / ".ssh/authorized_keys"
route = pathlib.Path("/etc/nginx/app-locations/lilt.conf")
if not dropin.is_file() or not keys.is_file() or not route.parent.is_dir():
    raise SystemExit("Expected existing NAS gateway configuration is missing")
if not route.exists() and command("ss", "-H", "-ltn", "sport = :18089").stdout.strip():
    raise SystemExit("New Lilt gateway port is already occupied")
config = dropin.read_text()
if "Match User nas-tunnel" not in config or "GatewayPorts no" not in config:
    raise SystemExit("Unexpected gateway forwarding policy")
matches = list(re.finditer(r"(?m)^(\s*PermitListen\s+)([^\n]+)$", config))
if len(matches) != 1 or "127.0.0.1:18088" not in matches[0].group(2).split():
    raise SystemExit("Unexpected existing application listener scope")
match = matches[0]
if scope not in match.group(2).split():
    config = config[:match.start(2)] + match.group(2) + " " + scope + config[match.end(2):]
key_text = keys.read_text()
lines = key_text.splitlines(keepends=True)
candidates = [i for i, line in enumerate(lines) if 'permitlisten="127.0.0.1:18088"' in line]
if len(candidates) != 1:
    raise SystemExit("Expected one existing restricted NAS gateway key")
index = candidates[0]
if 'permitlisten="127.0.0.1:18089"' not in lines[index]:
    lines[index] = lines[index].replace(
        'permitlisten="127.0.0.1:18088"',
        'permitlisten="127.0.0.1:18088",permitlisten="127.0.0.1:18089"', 1)
key_text = "".join(lines)
if route.exists() and route.read_text() != payload["route"]:
    raise SystemExit("Existing Lilt gateway route differs; reconcile it explicitly")
old = {path: path.read_bytes() if path.exists() else None for path in (dropin, keys, route)}
ssh_unit = "sshd" if command("systemctl", "is-active", "--quiet", "sshd", check=False).returncode == 0 else "ssh"
try:
    put(dropin, config)
    put(keys, key_text)
    put(route, payload["route"])
    command("sshd", "-t")
    command("nginx", "-t")
    command("systemctl", "reload", ssh_unit)
    command("systemctl", "reload", "nginx")
except Exception:
    for path, value in old.items():
        if value is None:
            path.unlink(missing_ok=True)
        else:
            put(path, value)
    for validator, unit in (("sshd", ssh_unit), ("nginx", "nginx")):
        try:
            command(validator, "-t")
            command("systemctl", "reload", unit)
        except Exception as rollback_error:
            print("Restored gateway configuration requires inspection: " + str(rollback_error), file=sys.stderr)
    raise
print("Gateway Lilt route and exact loopback forwarding scope installed")
'''


NAS_TUNNELS = ATOMIC + r'''
import grp, re, time
if pathlib.Path("/etc/server-maintenance-host").read_text().strip() != "nas":
    raise SystemExit("Application forwarding targets NAS")
root = pathlib.Path("/etc/nas-tunnels")
for gateway in ("ali", "vps"):
    seed = root / ("curio-" + gateway + ".conf")
    if not seed.is_file():
        seed = root / (gateway + ".conf")
    text = seed.read_text()
    def setting(name):
        matches = re.findall(r"(?mi)^\s*" + name + r"\s+([^\s#]+)", text)
        if len(matches) != 1:
            raise SystemExit("Unexpected existing NAS tunnel setting: " + name)
        return matches[0]
    if setting("User") != "nas-tunnel" or setting("IdentityFile") != "/etc/nas-tunnels/" + gateway + ".key":
        raise SystemExit("Unexpected existing NAS tunnel identity")
    value = payload["template"].replace("__GATEWAY_ADDRESS__", setting("HostName")).replace("__GATEWAY__", gateway).replace("__APP_PORT__", "18089")
    destination = root / ("lilt-" + gateway + ".conf")
    if destination.exists() and destination.read_text() != value:
        raise SystemExit("Existing Lilt tunnel differs; reconcile it explicitly")
    put(destination, value, 0o640)
    os.chown(destination, 0, grp.getgrnam("nas-tunnel").gr_gid)
    os.chmod(destination, 0o640)
    command("runuser", "-u", "nas-tunnel", "--", "ssh", "-F", str(destination), "-G", "gateway")
dropin = pathlib.Path("/etc/systemd/system/reverse-tunnel@lilt-vps.service.d")
dropin.mkdir(mode=0o755, parents=True, exist_ok=True)
resilience = dropin / "10-resilience.conf"
if resilience.exists() and resilience.read_text() != payload["resilience"]:
    raise SystemExit("Existing Lilt VPS retry policy differs")
put(resilience, payload["resilience"])
command("systemctl", "daemon-reload")
for gateway in ("ali", "vps"):
    unit = "reverse-tunnel@lilt-" + gateway + ".service"
    command("systemctl", "enable", "--now", unit)
    command("systemctl", "is-active", "--quiet", unit)
print("Independent Lilt ALI/VPS tunnel units enabled; existing tunnels unchanged")
'''


CHECK_GATEWAY = ATOMIC + r'''
import time
for _ in range(30):
    result = command("ss", "-H", "-ltn", "sport = :18089")
    if "127.0.0.1:18089" in result.stdout:
        command("curl", "--fail", "--silent", "--max-time", "5", "http://127.0.0.1:18089/healthz")
        page = command("curl", "--fail", "--silent", "--max-time", "5", "http://127.0.0.1:18089/lilt/").stdout
        if 'name="application-name" content="Lilt"' not in page or "/lilt/assets/" not in page:
            raise SystemExit("Loopback listener is not the expected Lilt application")
        print("Gateway loopback listener reaches Lilt on NAS")
        break
    time.sleep(1)
else:
    raise SystemExit("Lilt loopback listener did not become available")
'''


RECOVERY = ATOMIC + r'''
root = pathlib.Path("/opt/lilt")
registry = pathlib.Path("/opt/serverportal/registry.d/lilt.json")
declaration = root / "config/portal.json"
if not registry.is_symlink() or registry.resolve(strict=True) != declaration.resolve(strict=True):
    raise SystemExit("Publish and verify Lilt's Portal declaration first")
entry = json.loads(declaration.read_text())
if entry.get("id") != "lilt":
    raise SystemExit("Unexpected Portal declaration ownership")
path = pathlib.Path("/etc/server-recovery.json")
value = json.loads(path.read_text())
apps = value.get("expectedApps")
if not isinstance(apps, list) or "curio" not in apps or value.get("host") != "nas":
    raise SystemExit("Unexpected existing NAS recovery configuration")
if "lilt" not in apps:
    apps.append("lilt")
    put(path, json.dumps(value, indent=2) + "\n", 0o600)
print("Registered Lilt added to expected recovery coverage; private destination settings preserved")
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("gateways", "recovery"))
    parser.add_argument("--nas", default="nas", help="Trusted NAS administrator SSH alias")
    args = parser.parse_args()
    if args.action == "recovery":
        remote(args.nas, RECOVERY, {})
        return
    route = (ROOT / "deploy/nginx-location.conf").read_text()
    if "127.0.0.1:18089" not in route:
        parser.error("Lilt gateway source must target loopback port 18089")
    for gateway in ("ali", "vps"):
        remote(gateway, GATEWAY, {"route": route})
    remote(args.nas, NAS_TUNNELS, {
        "template": (SHARED / "assets/nas/application-tunnel.conf.template").read_text(),
        "resilience": (SHARED / "assets/nas/vps-tunnel-resilience.conf").read_text(),
    })
    for gateway in ("ali", "vps"):
        remote(gateway, CHECK_GATEWAY, {})


if __name__ == "__main__":
    main()
