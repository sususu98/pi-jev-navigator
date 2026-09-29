#!/usr/bin/env bash
set -euo pipefail
# Compatibility entrypoint; the portable builder also supports npm on Windows.
exec node "$(dirname "$0")/build-native.mjs"
