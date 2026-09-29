#!/usr/bin/env bash
set -euo pipefail

mkdir -p bin

echo ">>> Building Native Go AST Binary (Darwin ARM64)..."
CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/jev-graph cmd/jev-graph/main.go

echo ">>> Native build complete: bin/jev-graph"
ls -la bin/jev-graph
