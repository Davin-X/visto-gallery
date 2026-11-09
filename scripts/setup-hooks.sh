#!/bin/sh
# Point Git at the hooks tracked in .githooks/.
# Safe to run repeatedly; silently does nothing outside a Git checkout.

cd "$(dirname "$0")/.." 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

chmod +x .githooks/* 2>/dev/null || true
git config core.hooksPath .githooks || exit 0
