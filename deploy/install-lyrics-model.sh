#!/usr/bin/env bash
set -euo pipefail

# Install only after the administrator authorizes the isolated NAS service.
if [[ $# -ne 1 ]]; then
  printf 'Usage: %s BUNDLE_DIRECTORY\nBundle: source.tar.gz, model.zip, lyrics-model.lock, lilt-lyrics.service\n' "$0" >&2
  exit 2
fi
[[ $(id -u) == 0 ]] || { printf 'Run as administrator on nas.\n' >&2; exit 1; }
root=/opt/lilt/bin/lyrics-model
bundle=$(cd "$1" && pwd)
[[ ! -e "$root" ]] || { printf 'Existing runtime is preserved: %s\n' "$root" >&2; exit 1; }
[[ ! -e /opt/lilt/config/lilt-lyrics.service && ! -e /etc/systemd/system/lilt-lyrics.service && ! -L /etc/systemd/system/lilt-lyrics.service ]] || { printf 'Existing lyrics unit is preserved.\n' >&2; exit 1; }
[[ -f /opt/lilt/data/lilt.sqlite ]] || { printf 'Install the Lilt application first.\n' >&2; exit 1; }
command -v uv >/dev/null
command -v unzip >/dev/null
printf '%s  %s\n' a4b15d5a2e75f237b5ac919fb1b9d8619d40cf06f9d13a19abdba3da45e43b60 "$bundle/source.tar.gz" 63a8c6191fe6bdf29ac40af2955ef96816b8391596d94a4340e0f58dcf47f26e "$bundle/model.zip" | sha256sum -c -
mkdir -p "$root/SOFA" "$root/model" "$root/python"
chmod 0755 "$root" "$root/python"
export UV_PYTHON_INSTALL_DIR="$root/python"
uv python install 3.11.16
uv venv --python 3.11.16 "$root/venv"
uv pip sync --python "$root/venv/bin/python" --require-hashes -r "$bundle/lyrics-model.lock"
tar -xzf "$bundle/source.tar.gz" -C "$root/SOFA" --strip-components=1
unzip -q "$bundle/model.zip" -d "$root/model"
mv "$root/model/pretrained_mandarin_singing/v1.0.0_mandarin_singing.ckpt" "$root/model/model.ckpt"
printf '%s  %s\n' 612cb69ef3503befc43286f0d90893b4b3ad959df07ed08799dba2bea69d2b51 "$root/model/model.ckpt" | sha256sum -c -
install -m 0644 "$bundle/lyrics-model.lock" "$root/requirements.lock"
chmod -R a+rX "$root"
"$root/venv/bin/python" -c 'import sys; sys.path.insert(0,"/opt/lilt/bin/lyrics-model/SOFA"); from modules.task.forced_alignment import LitForcedAlignmentTask; m=LitForcedAlignmentTask.load_from_checkpoint("/opt/lilt/bin/lyrics-model/model/model.ckpt",map_location="cpu"); print("SOFA model loaded")'
install -m 0644 "$bundle/lilt-lyrics.service" /opt/lilt/config/lilt-lyrics.service
ln -s /opt/lilt/config/lilt-lyrics.service /etc/systemd/system/lilt-lyrics.service
systemctl daemon-reload
systemctl enable lilt-lyrics.service
printf 'Prepared isolated Lilt model worker on nas; the next Lilt release starts it.\n'
