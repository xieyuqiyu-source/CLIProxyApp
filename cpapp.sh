#!/usr/bin/env bash
#
# CLIProxyApp helper script.
#
# Usage:
#   ./cpapp.sh dev    Start CLIProxyApp in Tauri development mode.
#   ./cpapp.sh dmg    Build a macOS .dmg package.
#
# The Tauri config already runs prepare:sidecar (Go build of ../CLIProxyApi)
# and prepare:cpm (npm build of ../CLIProxyManagement) via its
# beforeDevCommand / beforeBuildCommand hooks, so this script only manages
# the toolchain, dependencies, and the entry command.

set -euo pipefail

# Resolve the directory this script lives in (the aggregated workspace root),
# so it works no matter where it is invoked from.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/CLIProxyApp"
CPA_DIR="$ROOT_DIR/CLIProxyApi"
CPM_DIR="$ROOT_DIR/CLIProxyManagement"

# --- pretty logging -------------------------------------------------------
info()  { printf '\033[1;34m[cpapp]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[cpapp]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[cpapp]\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m[cpapp]\033[0m %s\n' "$*" >&2; exit 1; }

# --- make rust available in this shell ------------------------------------
# rustup installs cargo/rustc under ~/.cargo/bin; non-login shells may not
# have it on PATH yet, so source the env file when present.
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

# --- environment checks ---------------------------------------------------
check_env() {
  local missing=0
  command -v node  >/dev/null 2>&1 || { warn "node not found";  missing=1; }
  command -v npm   >/dev/null 2>&1 || { warn "npm not found";   missing=1; }
  command -v go    >/dev/null 2>&1 || { warn "go not found (needed for the CLIProxyApi sidecar)"; missing=1; }
  command -v rustc >/dev/null 2>&1 || { warn "rustc not found (install via https://rustup.rs)";   missing=1; }
  command -v cargo >/dev/null 2>&1 || { warn "cargo not found (install via https://rustup.rs)";   missing=1; }
  [ "$missing" -eq 0 ] || die "Required tools are missing. See warnings above."

  [ -d "$APP_DIR" ] || die "CLIProxyApp not found at $APP_DIR"
  [ -d "$CPA_DIR" ] || die "CLIProxyApi not found at $CPA_DIR (needed for the sidecar build)"
  [ -d "$CPM_DIR" ] || die "CLIProxyManagement not found at $CPM_DIR (needed for the management UI build)"
}

# --- ensure CLIProxyApp dependencies are installed ------------------------
ensure_deps() {
  if [ ! -d "$APP_DIR/node_modules" ]; then
    info "Installing CLIProxyApp dependencies (npm install)..."
    ( cd "$APP_DIR" && npm install )
  else
    info "CLIProxyApp dependencies already present, skipping npm install."
  fi
}

cmd_dev() {
  check_env
  ensure_deps
  info "Starting Tauri development mode (Ctrl+C to stop)..."
  ( cd "$APP_DIR" && npm run tauri dev )
}

cmd_dmg() {
  [ "$(uname -s)" = "Darwin" ] || die "DMG packaging is only supported on macOS."
  check_env
  ensure_deps
  info "Building macOS .dmg package (this can take a while on the first run)..."
  ( cd "$APP_DIR" && npm run tauri build -- --bundles dmg )

  local dmg_dir="$APP_DIR/src-tauri/target/release/bundle/dmg"
  local dmg_file
  dmg_file="$(ls -t "$dmg_dir"/*.dmg 2>/dev/null | head -1 || true)"
  if [ -n "$dmg_file" ]; then
    ok "DMG built: $dmg_file"
    open "$dmg_dir" >/dev/null 2>&1 || true
  else
    warn "Build finished but no .dmg was found under $dmg_dir"
  fi
}

usage() {
  cat <<EOF
CLIProxyApp helper

Usage:
  ./cpapp.sh dev    Start CLIProxyApp in development mode (hot reload)
  ./cpapp.sh dmg    Build a macOS .dmg package

Shortcuts:
  ./dev.sh          same as ./cpapp.sh dev
  ./build-dmg.sh    same as ./cpapp.sh dmg
EOF
}

case "${1:-}" in
  dev)        cmd_dev ;;
  dmg|build)  cmd_dmg ;;
  ""|-h|--help|help) usage ;;
  *) die "Unknown command: $1 (use dev or dmg)" ;;
esac
