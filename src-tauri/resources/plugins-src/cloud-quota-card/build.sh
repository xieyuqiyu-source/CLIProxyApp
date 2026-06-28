#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$ROOT_DIR/plugins-src/cloud-quota-card"
GOOS_VALUE="${GOOS:-$(go env GOOS)}"
GOARCH_VALUE="${GOARCH:-$(go env GOARCH)}"
EXT=".so"
if [[ "$GOOS_VALUE" == "darwin" ]]; then
  EXT=".dylib"
elif [[ "$GOOS_VALUE" == "windows" ]]; then
  EXT=".dll"
fi

OUT_DIR="$ROOT_DIR/plugins/$GOOS_VALUE/$GOARCH_VALUE"
mkdir -p "$OUT_DIR"

cd "$SRC_DIR"
CGO_ENABLED=1 GOOS="$GOOS_VALUE" GOARCH="$GOARCH_VALUE" go build -buildmode=c-shared -o "$OUT_DIR/cloud-quota-card$EXT" .
rm -f "$OUT_DIR/cloud-quota-card.h"

echo "$OUT_DIR/cloud-quota-card$EXT"
