#!/usr/bin/env bash
# One-click: build a macOS .dmg package for CLIProxyApp.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/cpapp.sh" dmg
