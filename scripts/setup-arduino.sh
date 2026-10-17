#!/usr/bin/env bash
set -euo pipefail

# Repository-local toolchain. No global Arduino settings or libraries are changed.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARDUINO_DIR="$ROOT/.arduino"
CLI_VERSION="${ARDUINO_CLI_VERSION:-1.3.1}"
CORE_VERSION="${ARDUINO_AVR_VERSION:-1.8.6}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=macOS_ARM64 ;;
  Darwin-x86_64) PLATFORM=macOS_64bit ;;
  Linux-x86_64) PLATFORM=Linux_64bit ;;
  Linux-aarch64|Linux-arm64) PLATFORM=Linux_ARM64 ;;
  *) echo "Unsupported platform. Install Arduino CLI and set ARDUINO_CLI_PATH." >&2; exit 1 ;;
esac
mkdir -p "$ARDUINO_DIR/bin" "$ARDUINO_DIR/data" "$ARDUINO_DIR/downloads" "$ARDUINO_DIR/user"
if [[ ! -x "$ARDUINO_DIR/bin/arduino-cli" ]]; then
  ARCHIVE="arduino-cli_${CLI_VERSION}_${PLATFORM}.tar.gz"
  RELEASE="https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}"
  curl --fail --location --retry 3 "$RELEASE/$ARCHIVE" -o "$ARDUINO_DIR/$ARCHIVE"
  curl --fail --location --retry 3 "$RELEASE/${CLI_VERSION}-checksums.txt" -o "$ARDUINO_DIR/checksums.txt"
  (cd "$ARDUINO_DIR" && awk -v archive="$ARCHIVE" '$2 == archive { print }' checksums.txt > selected-checksum.txt
    test -s selected-checksum.txt
    if command -v sha256sum >/dev/null 2>&1; then sha256sum -c selected-checksum.txt; else shasum -a 256 -c selected-checksum.txt; fi)
  tar -xzf "$ARDUINO_DIR/$ARCHIVE" -C "$ARDUINO_DIR/bin" arduino-cli
fi
export ARDUINO_DIRECTORIES_DATA="$ARDUINO_DIR/data"
export ARDUINO_DIRECTORIES_DOWNLOADS="$ARDUINO_DIR/downloads"
export ARDUINO_DIRECTORIES_USER="$ARDUINO_DIR/user"
export ARDUINO_UPDATER_ENABLE_NOTIFICATION=false
"$ARDUINO_DIR/bin/arduino-cli" core update-index
"$ARDUINO_DIR/bin/arduino-cli" core install "arduino:avr@$CORE_VERSION"
"$ARDUINO_DIR/bin/arduino-cli" version
"$ARDUINO_DIR/bin/arduino-cli" core list
