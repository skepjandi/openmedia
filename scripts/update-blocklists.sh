#!/usr/bin/env bash
# Refreshes the bundled filter lists from their upstream. Run by a developer, never by the app.
set -euo pipefail

cd "$(dirname "$0")/../blocklists"

BRAVE_RESOURCES_REVISION=6da9b247c3368baa8b4f24cd02046e18702a6527
BRAVE_LISTS_REVISION=a190fe07fe27b697dc796d54a54b58dfd75e7b1c

fetch() {
  local name="$1" url="$2" tmp
  tmp="$(mktemp)"
  if ! curl --fail --silent --show-error --location "$url" --output "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! head -n 1 "$tmp" | grep -q '^\\[Adblock Plus'; then
    echo "unexpected content from $url" >&2
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$name"
  grep -m1 '^! Version:' "$name" | sed "s/^/$name /"
}

fetch_pinned() {
  local name="$1" url="$2" validator="$3" tmp
  tmp="$(mktemp)"
  if ! curl --fail --silent --show-error --location "$url" --output "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! "$validator" "$tmp"; then
    echo "unexpected content from $url" >&2
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$name"
}

valid_brave_list() {
  grep -q '^! Title: Brave Specific$' "$1"
}

valid_brave_ios_list() {
  grep -q '^! Brave IOS specific filters$' "$1"
}

valid_resources() {
  node -e '
    const resources = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(resources) || resources.length === 0) process.exit(1);
  ' "$1"
}

fetch easylist.txt https://easylist.to/easylist/easylist.txt
fetch easyprivacy.txt https://easylist.to/easylist/easyprivacy.txt
fetch_pinned brave-specific.txt \
  "https://raw.githubusercontent.com/brave/adblock-lists/$BRAVE_LISTS_REVISION/brave-lists/brave-specific.txt" \
  valid_brave_list
fetch_pinned brave-ios-specific.txt \
  "https://raw.githubusercontent.com/brave/adblock-lists/$BRAVE_LISTS_REVISION/brave-lists/brave-ios-specific.txt" \
  valid_brave_ios_list
fetch_pinned brave-resources.json \
  "https://raw.githubusercontent.com/brave/adblock-resources/$BRAVE_RESOURCES_REVISION/dist/resources.json" \
  valid_resources
