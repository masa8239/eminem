#!/bin/sh
# 仕様の照合表 data/spec-reference.json を作り直す（AMD公式の仕様一覧と Wikipedia の各世代の表から）。
# 使い方: リポジトリのルートで  sh tools/spec-reference/build.sh
# 必要: python3、curl。作業ファイルは一時フォルダに置き、終わったら消す。
set -eu
ROOT=$(pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp tools/spec-reference/*.py "$WORK"/
cd "$WORK"
curl -sS -A "Mozilla/5.0" --max-time 120 -o amd_processors.html https://www.amd.com/en/products/specifications/processors.html
curl -sS -A "Mozilla/5.0" --max-time 120 -o amd_graphics.html https://www.amd.com/en/products/specifications/graphics.html
python3 -I amdref.py amd_processors.html
python3 -I cpuref.py
python3 -I - amd_graphics.html <<'PY'
import sys
sys.argv = ['gpuref.py', sys.argv[1]]
exec(open('gpuref.py').read())
PY
python3 -I merge.py amd_graphics.html "$ROOT/data/spec-reference.json"
