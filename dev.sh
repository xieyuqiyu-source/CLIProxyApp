#!/usr/bin/env bash
# One-click: start CLIProxyApp in development mode.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/cpapp.sh" dev
