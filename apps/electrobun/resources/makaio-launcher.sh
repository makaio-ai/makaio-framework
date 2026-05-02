#!/bin/bash
# macOS launcher for the Makaio CLI - execs the bundled Bun runtime with cli.mjs.
#
# Unlike Electron, the Electrobun app bundle ships a standalone Bun binary that
# can directly execute JS files without any special environment variable.
#
# Installed by Homebrew cask post-install or install-cli.sh.
set -euo pipefail

MAKAIO_APP="${MAKAIO_APP:-/Applications/Makaio.app}"
BUN_BIN="${MAKAIO_APP}/Contents/MacOS/bun"

if [[ ! -x "${BUN_BIN}" ]]; then
  echo "error: Makaio.app not found at ${MAKAIO_APP}" >&2
  echo "Install Makaio or set MAKAIO_APP to the correct path." >&2
  exit 1
fi

exec "${BUN_BIN}" "${MAKAIO_APP}/Contents/Resources/app/dist/cli.mjs" "$@"
