#!/bin/sh
# Builds the Mac App Store package Transporter takes: the release .app, signed with the sandbox
# entitlements and the Mac App Store provisioning profile, wrapped in a signed installer .pkg.
#
#   yarn tauri build --bundles app
#   MAS_APP_IDENTITY="3rd Party Mac Developer Application: ..." \
#   MAS_INSTALLER_IDENTITY="3rd Party Mac Developer Installer: ..." \
#   MAS_PROFILE=path/to/OpenMedia.provisionprofile \
#   sh scripts/package-mac-app-store.sh
#
# The identities (certificate name or SHA-1) and the profile come from the Apple Developer account
# (see docs/wiki/store-builds.md). Set MAS_KEYCHAIN to sign from a keychain that is not in the
# search list, and MAS_APP to package an .app other than the one `yarn tauri build` made. The result
# is OpenMedia-MacAppStore.pkg next to that .app (src-tauri/target/release/bundle/macos by default).
set -eu

: "${MAS_APP_IDENTITY:?set MAS_APP_IDENTITY}"
: "${MAS_INSTALLER_IDENTITY:?set MAS_INSTALLER_IDENTITY}"
: "${MAS_PROFILE:?set MAS_PROFILE}"

root=$(cd "$(dirname "$0")/.." && pwd)
app=${MAS_APP:-$root/src-tauri/target/release/bundle/macos/OpenMedia.app}
bundle=$(dirname "$app")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
keychain=${MAS_KEYCHAIN:+--keychain $MAS_KEYCHAIN}

[ -d "$app" ] || { echo "build the app first: yarn tauri build --bundles app" >&2; exit 1; }

profile_plist="$work/profile.plist"
security cms -D -i "$MAS_PROFILE" > "$profile_plist"
app_id=$(plutil -extract Entitlements.com.apple.application-identifier raw "$profile_plist")
team_id=$(plutil -extract Entitlements.com.apple.developer.team-identifier raw "$profile_plist")

# The sandbox entitlements, plus the identifiers the profile grants.
entitlements="$work/OpenMedia.entitlements"
cp "$root/src-tauri/macos/OpenMedia.entitlements" "$entitlements"
plutil -insert com.apple.application-identifier -string "$app_id" "$entitlements"
plutil -insert com.apple.developer.team-identifier -string "$team_id" "$entitlements"

signed="$work/OpenMedia.app"
cp -R "$app" "$signed"
# HTTPS only, no custom cryptography: answers the export-compliance question at upload.
plutil -replace ITSAppUsesNonExemptEncryption -bool false "$signed/Contents/Info.plist"
cp "$MAS_PROFILE" "$signed/Contents/embedded.provisionprofile"

# shellcheck disable=SC2086
codesign --force $keychain --sign "$MAS_APP_IDENTITY" --entitlements "$entitlements" --timestamp "$signed"
codesign --verify --strict "$signed"

out="$bundle/OpenMedia-MacAppStore.pkg"
rm -f "$out"
# shellcheck disable=SC2086
productbuild --component "$signed" /Applications $keychain --sign "$MAS_INSTALLER_IDENTITY" "$out"
echo "$out"
