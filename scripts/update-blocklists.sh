#!/usr/bin/env bash
# Refreshes the bundled filter lists from their upstream. Run by a developer or by the scheduled
# `Blocklists` workflow, never by the app.
#
# Every list is validated before it replaces the bundled copy: a changed upstream format fails
# the run instead of shipping an empty or wrong list. Revisions below are pinned so a run is
# reproducible; the workflow moves them to the latest upstream commit (`scripts/bump-blocklist-pins.sh`).
set -euo pipefail

cd "$(dirname "$0")/../blocklists"

BRAVE_RESOURCES_REVISION=fb431e85ace0a53adb0c4a497c34160404df347c
BRAVE_LISTS_REVISION=a190fe07fe27b697dc796d54a54b58dfd75e7b1c
UBLOCK_ASSETS_REVISION=c7e01d34f95bfcbda34127a1bbc63ca6980217aa

download() {
  local url="$1" tmp="$2"
  curl --fail --silent --show-error --location --retry 3 "$url" --output "$tmp"
}

# fetch NAME URL VALIDATOR: replaces NAME only when the download passes VALIDATOR.
fetch() {
  local name="$1" url="$2" validator="$3" tmp
  tmp="$(mktemp)"
  if ! download "$url" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  # Some upstreams serve CRLF; one line ending keeps diffs and list ids stable.
  tr -d '\r' <"$tmp" >"$tmp.lf" && mv "$tmp.lf" "$tmp"
  if ! "$validator" "$tmp"; then
    echo "unexpected content from $url" >&2
    rm -f "$tmp"
    return 1
  fi
  # App Review (guideline 5): no links to sanctioned-territory sites in the binary.
  grep -v -e 'zoomit\.ir/product' -e 'offerdaily\.ir' -e 'api2\.zoomit\.ir' "$tmp" >"$tmp.f" || true
  mv "$tmp.f" "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$name"
  grep -m1 -E '^! (Version|Last modified):' "$name" | sed "s/^/$name /" || true
}

abp_header() {
  head -n 1 "$1" | grep -q '^!\{0,1\}\[Adblock Plus'
}

title_is() {
  grep -q "^! Title: $2\$" "$1"
}

valid_easylist() { abp_header "$1"; }
valid_peter_lowe() { abp_header "$1"; }
valid_adguard_mobile() { title_is "$1" 'AdGuard Mobile Ads filter'; }
valid_ublock_filters() { title_is "$1" 'uBlock filters'; }
valid_ublock_privacy() { title_is "$1" 'uBlock filters – Privacy'; }
valid_ublock_badware() { title_is "$1" 'uBlock₀ filters – Badware risks'; }
valid_ublock_unbreak() { title_is "$1" 'uBlock filters – Unbreak'; }
valid_ublock_quick_fixes() { title_is "$1" 'uBlock₀ filters – Quick fixes'; }
valid_ublock_resource_abuse() { title_is "$1" 'uBlock filters – Resource abuse'; }
valid_brave_list() { title_is "$1" 'Brave Specific'; }
valid_brave_firstparty() { title_is "$1" 'Brave Firstparty specific filters'; }
valid_brave_ios_list() { grep -q '^! Brave IOS specific filters$' "$1"; }

# The CNAME list has no title; it is a plain run of `||host^` rules.
valid_brave_cname() {
  [ "$(grep -c '^||[a-z0-9.-]*\^$' "$1")" -gt 1000 ]
}

# The regional first-party list has no title either.
valid_brave_regional() {
  grep -q '^!! French generic$' "$1"
}

valid_json_array() {
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(value) || value.length === 0) process.exit(1);
  ' "$1"
}

valid_url_rules() {
  node -e '
    const rules = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const ok = Array.isArray(rules) && rules.length > 0 &&
      rules.every((r) => Array.isArray(r.include) && r.include.every((p) => typeof p === "string"));
    process.exit(ok ? 0 : 1);
  ' "$1"
}

UBLOCK="https://raw.githubusercontent.com/uBlockOrigin/uAssets/$UBLOCK_ASSETS_REVISION/filters"
BRAVE="https://raw.githubusercontent.com/brave/adblock-lists/$BRAVE_LISTS_REVISION/brave-lists"

fetch easylist.txt https://easylist.to/easylist/easylist.txt valid_easylist
fetch easyprivacy.txt https://easylist.to/easylist/easyprivacy.txt valid_easylist
fetch peter-lowe.txt \
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext" \
  valid_peter_lowe
fetch adguard-mobile.txt https://filters.adtidy.org/extension/ublock/filters/11.txt valid_adguard_mobile

fetch ublock-filters.txt "$UBLOCK/filters.txt" valid_ublock_filters
fetch ublock-privacy.txt "$UBLOCK/privacy.txt" valid_ublock_privacy
fetch ublock-badware.txt "$UBLOCK/badware.txt" valid_ublock_badware
fetch ublock-unbreak.txt "$UBLOCK/unbreak.txt" valid_ublock_unbreak
fetch ublock-quick-fixes.txt "$UBLOCK/quick-fixes.txt" valid_ublock_quick_fixes
fetch ublock-resource-abuse.txt "$UBLOCK/resource-abuse.txt" valid_ublock_resource_abuse

fetch brave-specific.txt "$BRAVE/brave-specific.txt" valid_brave_list
fetch brave-ios-specific.txt "$BRAVE/brave-ios-specific.txt" valid_brave_ios_list
fetch brave-firstparty.txt "$BRAVE/brave-firstparty.txt" valid_brave_firstparty
fetch brave-firstparty-cname.txt "$BRAVE/brave-firstparty-cname.txt" valid_brave_cname
fetch brave-firstparty-regional.txt "$BRAVE/brave-firstparty-regional.txt" valid_brave_regional

# Link cleaning data: tracking query parameters and redirect-tracker (bounce) URLs.
fetch brave-query-filter.json "$BRAVE/query-filter.json" valid_url_rules
fetch brave-clean-urls.json "$BRAVE/clean-urls.json" valid_url_rules
fetch brave-debounce.json "$BRAVE/debounce.json" valid_url_rules

fetch brave-resources.json \
  "https://raw.githubusercontent.com/brave/adblock-resources/$BRAVE_RESOURCES_REVISION/dist/resources.json" \
  valid_json_array
