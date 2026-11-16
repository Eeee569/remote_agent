#!/bin/bash
# Run on the Mac, from this directory: generates RemoteAgent.xcodeproj and opens it.
set -euo pipefail
cd "$(dirname "$0")"

if ! xcode-select -p >/dev/null 2>&1 || [ ! -d "$(xcode-select -p)/Platforms/iPhoneOS.platform" ]; then
  echo "Xcode is required (free, from the Mac App Store). Install it, open it once," >&2
  echo "then run:  sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

XCODEGEN="$(command -v xcodegen || true)"
if [ -z "$XCODEGEN" ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing XcodeGen with Homebrew..."
    brew install xcodegen
    XCODEGEN="$(command -v xcodegen)"
  else
    echo "Downloading XcodeGen into .tools/ ..."
    mkdir -p .tools
    curl -fsSL -o .tools/xcodegen.zip \
      https://github.com/yonaskolb/XcodeGen/releases/latest/download/xcodegen.zip
    unzip -oq .tools/xcodegen.zip -d .tools
    XCODEGEN="$PWD/.tools/xcodegen/bin/xcodegen"
  fi
fi

# A free Apple ID can only sign a bundle id nobody else has registered.
user="$(whoami | tr -cd 'a-zA-Z0-9' | tr 'A-Z' 'a-z')"
export RA_BUNDLE_ID="${RA_BUNDLE_ID:-dev.${user:-me}.remoteagent}"
echo "Bundle identifier: $RA_BUNDLE_ID"

"$XCODEGEN" generate --spec project.yml
open RemoteAgent.xcodeproj
