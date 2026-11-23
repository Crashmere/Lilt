#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s BUNDLE_DIRECTORY\nBundle: english.ckpt, english-dictionary.txt, lyrics-english-NOTICE.md\n' "$0" >&2
  exit 2
fi
[[ $(id -u) == 0 ]] || { printf 'Run as administrator on nas.\n' >&2; exit 1; }
root=/opt/lilt/bin/lyrics-model
bundle=$(cd "$1" && pwd)
[[ -f "$root/venv/bin/python" && -f "$root/SOFA/modules/task/forced_alignment.py" ]] || { printf 'Install the isolated SOFA runtime first.\n' >&2; exit 1; }
checkpoint=6aba5f0ba3461155bf0c20190df85fad580de42409784737573309f6962449ff
dictionary=1b2a52ac559169196cb7cdfd3edcfe3947d37ec6a28a6ec281abac838331439c
printf '%s  %s\n' "$checkpoint" "$bundle/english.ckpt" "$dictionary" "$bundle/english-dictionary.txt" | sha256sum -c -
[[ -f "$bundle/lyrics-english-NOTICE.md" ]] || { printf 'Preserve the English source and permission notice in the bundle.\n' >&2; exit 1; }
for file in english.ckpt english-dictionary.txt; do
  if [[ -e "$root/model/$file" ]]; then
    expected=$checkpoint
    [[ "$file" != english-dictionary.txt ]] || expected=$dictionary
    printf '%s  %s\n' "$expected" "$root/model/$file" | sha256sum -c - || { printf 'Existing English files are preserved.\n' >&2; exit 1; }
  fi
done
stage=$(mktemp -d "$root/model/.english-install-XXXXXX")
trap 'rm -f "$stage/english.ckpt" "$stage/english-dictionary.txt" "$stage/english-notice.md"; rmdir "$stage"' EXIT
chmod 0755 "$stage"
install -m 0644 "$bundle/english.ckpt" "$stage/english.ckpt"
install -m 0644 "$bundle/english-dictionary.txt" "$stage/english-dictionary.txt"
install -m 0644 "$bundle/lyrics-english-NOTICE.md" "$stage/english-notice.md"
runuser -u lilt -- env PYTHONNOUSERSITE=1 MPLCONFIGDIR=/opt/lilt/data/analysis/matplotlib NUMBA_CACHE_DIR=/opt/lilt/data/analysis/numba "$root/venv/bin/python" - "$root" "$stage" <<'PY'
import pathlib
import sys
import torch

root, stage = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(root / "SOFA"))
from modules.task.forced_alignment import LitForcedAlignmentTask

torch.set_num_threads(2)
model = LitForcedAlignmentTask.load_from_checkpoint(str(stage / "english.ckpt"), map_location="cpu").eval()
with (stage / "english-dictionary.txt").open(encoding="utf-8") as source:
    phones = {phone for line in source if line.strip() for phone in line.strip().split("\t", 1)[1].split()}
assert all(phone in model.vocab and model.vocab[phone] != 0 for phone in phones), "Dictionary and checkpoint phonemes differ"
mandarin = torch.load(root / "model" / "model.ckpt", map_location="cpu", weights_only=False)
assert model.melspec_config == mandarin["hyper_parameters"]["melspec_config"], "Mixed alignment requires identical acoustic features"
print("English checkpoint, dictionary and shared acoustic frame configuration verified under lilt")
PY
for file in english-dictionary.txt english-notice.md english.ckpt; do
  if [[ ! -e "$root/model/$file" ]]; then
    mv "$stage/$file" "$root/model/$file"
  fi
done
printf 'Prepared offline English model on nas without changing Python dependencies, Mandarin weights or services.\n'
