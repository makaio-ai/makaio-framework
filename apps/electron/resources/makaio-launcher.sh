#!/bin/bash
# macOS shell launcher for the Makaio CLI.
#
# Sets ELECTRON_RUN_AS_NODE=1 and execs the Electron binary with the
# bundled cli.mjs entry point. All args and env vars are passed through.
#
# Installed by Homebrew cask post-install or install-cli.sh.
set -euo pipefail

MAKAIO_APP="${MAKAIO_APP:-/Applications/Makaio.app}"
ELECTRON_BIN="${MAKAIO_APP}/Contents/MacOS/Makaio"

if [[ ! -x "${ELECTRON_BIN}" ]]; then
  echo "error: Makaio.app not found at ${MAKAIO_APP}" >&2
  echo "Install Makaio or set MAKAIO_APP to the correct path." >&2
  exit 1
fi

ELECTRON_RUN_AS_NODE=1 exec "${ELECTRON_BIN}" \
  "${MAKAIO_APP}/Contents/Resources/app.asar/dist/cli.mjs" "$@"
