#!/bin/sh
# Converts the bundled filter lists exactly as the app does and compiles each result with this
# Mac's WebKit, the compiler iOS and macOS use. Catches a list WebKit would reject on a device
# (one bad rule fails the whole list) and shows compile time and size. Needs macOS with Xcode's
# command line tools and a Rust toolchain.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

OPENMEDIA_RULE_DIR="$out/rules" cargo test --manifest-path "$root/src-tauri/Cargo.toml" \
  --lib ad_block::tests::write_rule_lists -- --ignored --exact
swiftc -o "$out/webkit-rule-check" "$root/scripts/webkit-rule-check/main.swift"
"$out/webkit-rule-check" "$out/rules"
