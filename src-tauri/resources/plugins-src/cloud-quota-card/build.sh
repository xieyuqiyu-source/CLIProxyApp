#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$ROOT_DIR/plugins-src/cloud-quota-card-rust"
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

cargo build --manifest-path "$SRC_DIR/Cargo.toml" --release
case "$EXT" in
  ".dylib") BUILT_LIB="$SRC_DIR/target/release/libcliproxy_cloud_quota_card.dylib" ;;
  ".so") BUILT_LIB="$SRC_DIR/target/release/libcliproxy_cloud_quota_card.so" ;;
  ".dll") BUILT_LIB="$SRC_DIR/target/release/cliproxy_cloud_quota_card.dll" ;;
esac
cp "$BUILT_LIB" "$OUT_DIR/cloud-quota-card$EXT"

echo "$OUT_DIR/cloud-quota-card$EXT"
