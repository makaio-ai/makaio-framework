#!/bin/bash
# Linux launcher for the Makaio CLI.
#
# Execs the standalone Bun binary shipped with the Makaio distribution
# with the bundled cli.mjs entry point. All args and env vars are passed through.
#
# Installed by .deb postinst or AppImage --install-cli flag.
set -euo pipefail

MAKAIO_APP="${MAKAIO_APP:-/opt/Makaio}"
BUN_BIN="${MAKAIO_APP}/bin/bun"

if [[ ! -x "${BUN_BIN}" ]]; then
  echo "error: Makaio not found at ${MAKAIO_APP}" >&2
  echo "Install Makaio or set MAKAIO_APP to the correct path." >&2
  exit 1
fi

exec "${BUN_BIN}" "${MAKAIO_APP}/Resources/app/dist/cli.mjs" "$@"
