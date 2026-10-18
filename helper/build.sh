#!/bin/zsh
# Builds bin/cc-helper. Note: rebuilding changes the binary's signature, so macOS may ask for permissions again.
set -e
cd "${0:A:h}"
mkdir -p ../bin
swiftc -O -swift-version 5 main.swift -o ../bin/cc-helper \
  -framework ScreenCaptureKit -framework Accelerate -framework EventKit -framework IOKit \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign -s - -i com.androbot.cc-helper -f ../bin/cc-helper
echo "built bin/cc-helper"
