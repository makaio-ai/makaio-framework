#!/bin/bash
# Linux shell launcher for the Makaio CLI.
#
# Sets ELECTRON_RUN_AS_NODE=1 and execs the Electron binary with the
# bundled cli.mjs entry point. All args and env vars are passed through.
#
# Installed by .deb postinst or AppImage --install-cli flag.
set -euo pipefail

MAKAIO_APP="${MAKAIO_APP:-/opt/Makaio}"
ELECTRON_BIN="${MAKAIO_APP}/makaio"

if [[ ! -x "${ELECTRON_BIN}" ]]; then
  echo "error: Makaio not found at ${MAKAIO_APP}" >&2
  echo "Install Makaio or set MAKAIO_APP to the correct path." >&2
  exit 1
fi

ELECTRON_RUN_AS_NODE=1 exec "${ELECTRON_BIN}" \
  "${MAKAIO_APP}/resources/app.asar/dist/cli.mjs" "$@"
