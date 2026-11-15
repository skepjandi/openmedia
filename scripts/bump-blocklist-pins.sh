#!/usr/bin/env bash
# Moves the upstream revisions pinned in scripts/update-blocklists.sh to each repository's latest
# default-branch commit. Run before update-blocklists.sh; the diff of the refreshed data is what a
# reviewer reads. Set GITHUB_TOKEN to avoid the unauthenticated API rate limit.
set -euo pipefail

script="$(dirname "$0")/update-blocklists.sh"

latest() {
  local repo="$1" auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl --fail --silent --show-error --retry 3 "${auth[@]}" \
    "https://api.github.com/repos/$repo/commits/HEAD" | node -e '
      let text = "";
      process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
        const sha = JSON.parse(text).sha;
        if (!/^[0-9a-f]{40}$/.test(sha)) process.exit(1);
        console.log(sha);
      });
    '
}

pin() {
  local variable="$1" repo="$2" sha
  sha="$(latest "$repo")"
  # BSD and GNU sed differ on -i; a temp file works with both.
  sed "s/^$variable=.*/$variable=$sha/" "$script" >"$script.tmp"
  mv "$script.tmp" "$script"
  chmod +x "$script"
  echo "$variable=$sha"
}

pin BRAVE_LISTS_REVISION brave/adblock-lists
pin BRAVE_RESOURCES_REVISION brave/adblock-resources
pin UBLOCK_ASSETS_REVISION uBlockOrigin/uAssets
