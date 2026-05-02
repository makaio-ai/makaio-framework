#!/bin/bash
# Install the Makaio CLI launcher to /usr/local/bin.
#
# Detects the platform, copies the appropriate launcher script, and
# makes it executable. Run with sudo if /usr/local/bin requires it.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "$(uname -s)" in
  Darwin)
    LAUNCHER="makaio-launcher.sh"
    ;;
  Linux)
    LAUNCHER="makaio-launcher-linux.sh"
    ;;
  *)
    echo "error: Unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

SOURCE="${SCRIPT_DIR}/${LAUNCHER}"
TARGET="${INSTALL_DIR}/makaio"

if [[ ! -f "${SOURCE}" ]]; then
  echo "error: Launcher not found at ${SOURCE}" >&2
  exit 1
fi

cp "${SOURCE}" "${TARGET}"
chmod +x "${TARGET}"
echo "Installed makaio CLI to ${TARGET}"
