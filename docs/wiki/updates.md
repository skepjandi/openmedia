# Updates (OTA)

> **Status: Implemented, with verification limits.** The web bundle path was run end to end on a macOS debug build (see [Verification](#verification)). Publishing to GitHub, the desktop self-update install, Windows and Linux hardware, and every mobile device were not exercised.

Two independent mechanisms, one CLI (`yarn ota`), and the same CLI inside GitHub Actions. For a shell-only change the whole routine is `yarn ota` (it means `yarn ota web`), or just merging to `main`: CI publishes it.

| | Web bundle | Desktop self-update |
|---|---|---|
| Replaces | The React shell (`dist/`) | The whole app binary |
| Platforms | iOS, Android, macOS, Windows, Linux | Windows and Linux builds from GitHub Releases (the only desktop downloads; macOS is store-only) |
| Mechanism | In-repo: `src-tauri/src/ota/` | `tauri-plugin-updater`, behind the `self-update` Cargo feature (`src-tauri/src/self_update.rs`) |
| Trust | Ed25519 over the bundle, key in `src-tauri/ota-public-key.txt` | Minisign, key in `src-tauri/tauri.ota.conf.json` |
| Hosted at | Release `ota` (pre-release): `latest-<version>.json` + `bundle-<version>-<revision>.ota` | The repository's latest release: `latest.json` + installers |
| Applies | Next launch, silently (checked 10 s after launch, and from Settings → Updates) | On the user's tap in Settings → Updates, then restarts |

Store builds (iOS App Store, Play, Mac App Store) are the only way to get iOS, Android and macOS: they have paid versions and are never published to GitHub Releases or the landing page (AGENTS.md, "Platforms and Pricing"). Windows and Linux are free and are the only platforms with desktop self-update. Store builds never contain the self-update code: the stores forbid an app replacing itself. They still get web bundles.

## The web bundle

A bundle is `signature (64 bytes) ‖ gzip(manifest JSON)`; the manifest carries `format`, `runtimeVersion`, `revision` and every file, base64. The signature covers a context string and the gzip bytes, so the app verifies before it decompresses or parses (`ota/bundle.rs`; the writer is `scripts/lib/ota-bundle.mjs`, and a Rust test opens a bundle the CLI wrote).

**Runtime version.** A bundle runs only on the native app whose `tauri.conf.json` `version` it was built for. The shell calls Rust commands; a bundle for another version could call ones that do not exist. **Bump `version` in the same change that touches Rust, a plugin, a capability or a permission.** A web-only change keeps the version and ships as a bundle. This rule is the whole compatibility story: CI publishes a bundle on every web-layer push to `main`, and nothing else checks the contract.

**Revision.** Unix seconds at publish time, so the newest wins with no counter to keep.

**Serving.** `OtaAssets` wraps Tauri's embedded assets (`Context::set_assets`). With an active bundle it serves only from the bundle, never mixing in an embedded file. The CLI adds Tauri's `__TAURI_STYLE_NONCE__` token to `index.html`'s inline `<style>`, as the build does for the embedded copy; without it the CSP would block the splash styles.

**Download.** `ota/client.rs`: HTTPS only, redirects only to HTTPS, every body size-capped, fixed error messages. The pointer is not trusted for anything but the revision; the file name is derived from it and the signature decides.

**Launch lifecycle.** A downloaded bundle is *pending* until the next launch, so the page in front of the user never changes under them. At that launch it is *active but unconfirmed*; the shell calls `ota_confirm` once it has loaded (`App.tsx`). A bundle that fails to confirm on two launches in a row is deleted and the embedded shell runs again (`ota/store.rs`). Any failure (bad signature, wrong runtime, unreadable file, corrupt state) falls back to the embedded shell.

**What a bundle cannot change.** Native code, permissions, the injected site engine and the blocklists (compiled into the binary), and the CSP. The shell remains the only caller of the commands, and no command here is reachable from a site view ([Security](./security.md)).

## Publishing from your machine

```bash
yarn ota keygen --github   # once; see below
yarn ota                   # same as `yarn ota web`
yarn ota web               # build, sign, publish the web bundle
yarn ota app               # on Windows or Linux: build the installer, upload, refresh latest.json
yarn ota all               # both
yarn ota web --dry-run     # build and sign into release/ota/, publish nothing
```

`web` refuses to publish (and says why) when Rust, a plugin or a capability changed after the current `version` was set, because apps on that version may lack what the new shell calls. Bump `version` and release the app, or pass `--force` for a change that does not touch the command contract. The check needs git history (CI checks out in full).

Needs the GitHub CLI logged in (`gh auth login`). The repository is `repository` in `src-tauri/Cargo.toml` (also what the app downloads from, at compile time) or `OTA_REPO`.

`yarn ota app` builds for the machine it runs on and refuses macOS and mobile targets (`--target <triple>` for another Windows or Linux Rust target). Installers are named `OpenMedia_<version>_<platform>.<ext>` (`windows-x86_64.exe`, `linux-x86_64.AppImage`); on Linux the `.deb` is uploaded beside the AppImage as `linux-x86_64.deb` and is not part of `latest.json`. `latest.json` is rebuilt from every signed installer on the release, so builds from several machines accumulate. `yarn ota manifest` rebuilds it on its own. The notes the updater shows come from `--notes "…"`.

A desktop release needs the version bumped in `tauri.conf.json` first (the updater compares versions), then:

```bash
git tag v1.1.0 && git push origin v1.1.0   # creates the release's tag; or let `yarn ota app` create it from HEAD
yarn ota app --notes "What changed"
```

`yarn release github` does the tag step and lets CI build both platforms. The Windows installer is not code-signed, so SmartScreen may warn on first install; Windows and Linux packaging has not been verified on hardware.

## Keys

`yarn ota keygen` makes both keys in `~/.openmedia/ota/` (`OPENMEDIA_OTA_KEY_DIR` to move it), writes the two public halves into the repository (`src-tauri/ota-public-key.txt`, `src-tauri/tauri.ota.conf.json`) and refuses to overwrite existing keys. `--github` also stores the private halves as repository secrets.

- **Losing a key** means no installed app accepts another update: every app already installed trusts only the public key it was built with. Back the folder up.
- **Rotating** (`--force`) needs a new app release through the stores first, then the new key.
- Neither private key is ever committed (`*.key` is gitignored).

## GitHub Actions

`.github/workflows/ota.yml` runs the same commands:

| Trigger | Does |
|---|---|
| Push to `main` touching the web layer | `yarn ota web` on Ubuntu (cheap minutes) |
| Push of a `v*` tag | web bundle, then `yarn ota app --no-manifest` on Windows and Ubuntu, then `yarn ota manifest` and the release notes; the `v<version>` release is marked latest |
| Manual run | web, app, or all |

Secrets: `OPENMEDIA_OTA_KEY`, `TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has one (all set by `yarn ota keygen --github`); `OPENMEDIA_SHARE_URL` for the desktop build, as `build.rs` reads them. The desktop jobs only run on a tag. There is no macOS job: macOS ships through the Mac App Store only. CI's `desktop-build` job (`ci.yml`) compile-checks the crate on Windows and Linux for pull requests.

## Requirements on the repository

The app downloads without credentials, so the release assets must be public. The repository is public (open source, MPL-2.0), so this holds. If a fork is private every check returns "Could not reach the update server."; point `repository` in `Cargo.toml` and the endpoint in `tauri.ota.conf.json` at a public releases repository (a test keeps those two in step).

## Privacy

A check is a plain `GET` to github.com: no identifier, no cookie, nothing about the user or their browsing; GitHub sees the IP address, as for any download (invariant 1, destination (d)). The launch check runs without a prompt and has no setting; the desktop install always waits for a tap.

## Verification

- `cargo test --lib ota`: signature, tamper, runtime, path, format and size checks; the launch lifecycle and rollback; a bundle written by the CLI.
- `yarn vitest run scripts`: bundle round trip, `latest.json` assembly, platform names, and that the updater endpoint matches `Cargo.toml`'s repository.
- Run by hand on a macOS debug build whose embedded shell predates `ota_confirm`: a bundle placed in the app's data folder became active and was confirmed, which only a page served from the bundle, with working IPC, could do. The same build with no bundle ran from the embedded shell. The window was not inspected visually.
- Not verified: a real publish to GitHub; `yarn ota app` on Windows or Linux (a signed desktop build and the updater installing it); how an OTA-served page looks (the style nonce is covered by a unit test, not by eye); Android and iOS.
