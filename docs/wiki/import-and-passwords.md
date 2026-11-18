# Import and the password vault

> **Status: Implemented; not run on a device.** Code: `src-tauri/src/import/` (`parse.rs`, `mod.rs`, `browsers/`), `vault.rs`, `fill.rs` + `fill.js`, `import_commands.rs`; shell: `features/import/ImportScreen.tsx`, `features/passwords/PasswordsScreen.tsx`, the Fill button in `features/sheet/PageTools.tsx`.

A person leaving another browser brings what it holds in one of two ways. Settings > *Import from another browser*:

1. **Straight from the browser** (Windows, Linux and the directly distributed macOS build): the screen lists the browsers installed on this computer and their profiles; one tap reads the profile. Code: `src-tauri/src/import/browsers/`.
2. **By choosing the files that browser exports**: the same on every platform, including sandboxed iOS and the Mac App Store build, which cannot read another app's folders (there the first list is empty and only this path shows).

Both feed the same pending state and the same preview, so everything under [The flow](#the-flow) applies to either.

## Reading a browser directly

`import_browsers` lists what `browsers::detect` finds from the user's folders: Chromium browsers (Chrome, Edge, Brave, Vivaldi, Arc, Chromium: `Default` and `Profile N`, named from `Local State`), Firefox profiles (those with a `places.sqlite`) and, on macOS, Safari. `import_from_browser(browser, profile)` accepts only ids that detection lists; nothing the shell sends is used as a path.

| Browser | Bookmarks, history, search engine | Saved logins |
|---|---|---|
| Chromium family | `Bookmarks` and `Preferences` JSON (the exported-file parsers), `History` database | `Login Data` database, opened with the browser's OS key: macOS Keychain item `<Browser> Safe Storage` (the OS asks the person to allow it), Windows DPAPI key in `Local State` (AES-256-GCM), Linux Secret Service via `secret-tool` or the fixed `peanuts` key (AES-128-CBC) |
| Firefox | `places.sqlite` | Counted (`logins.json`), not read: Firefox seals them with its own security library. The preview says how many and points at *about:logins* export |
| Safari (macOS) | `Bookmarks.plist`, `History.db`; macOS needs Full Disk Access for the app, and the error says so | Not read (system Keychain); Safari's own export covers them |

Databases are copied with their write-ahead log to a private temporary folder, read there and deleted (`sqlite.rs`), so a running browser's lock never matters and the original is never opened. The OS key is fetched only when a profile has logins, held in `Zeroizing` memory and dropped with the read. Blobs the app cannot open (Chrome's newer app-bound `v20` format) are counted as locked, never guessed. Choosing the same profile twice counts once (`ImportState::add` keeps the sources read). Nothing is sent anywhere (invariant 1).

## What is read

| File | Becomes |
|---|---|
| Bookmarks, HTML (Netscape format: every browser exports it) or a Chromium `Bookmarks` JSON | The sites the person uses, ranked (a bookmark counts as 3 visits) |
| History as JSON (`url`, `title`, `visit_count`/`visitCount`/`visits`) or CSV (`url` column, optional `title`, `visit_count`) | The same ranking, and History |
| Passwords, CSV (Chrome, Edge, Brave, Firefox, Safari, Bitwarden headers) | Logins in the vault |
| A Chromium `Preferences` JSON | The default search engine, when it is one of ours |

Parsers are tolerant: unknown text is an empty result. A web address is `http`/`https` with a dotted host; `place:`, `javascript:`, `chrome:` and `android:` entries are dropped. A JSON object that has a `password` key is never read as a link. Files are capped at 20 MiB.

## The flow

1. The shell reads each chosen file's text **once** and sends it to `import_read`. Rust keeps what it found in memory for 10 minutes (`ImportState`) and returns a `Preview`: counts, the top sites, the official recipes that match them (by registrable domain of the recipe's hosts) and the other top sites. Passwords never come back: the preview has two numbers.
2. The person ticks recipes, sites, history, search engine and passwords. `import_apply` does exactly that: installs the picked official recipes (and adds each as a favorite), adds the picked sites as favorites **without removing existing ones, up to 5**, adds the 100 most visited addresses to History (most visited on top), sets the search engine, seals the logins. A recipe or site the files did not offer is refused. Pending data is dropped when applied, cancelled or expired.
3. Nothing is sent anywhere (invariant 1).

## The vault

`passwords.vault` in the app data folder holds every login as JSON sealed with **AES-256-GCM** (`ring`; random 96-bit nonce per write, the file magic is the associated data). The 256-bit key is random and lives only in the OS secure store (`SecretStore`: Keychain, Credential Manager, Secret Service, Android Keystore) under a fixed id; if the store cannot keep it, the vault refuses (no key on disk). The file is written through a temporary file with mode `0600`. A copied file is noise without the key.

Passwords are `Zeroizing` where Rust holds them, `Debug` never prints them, and the listing type (`Meta`) has no password field. The shell can:

- list logins (site, username) and ask for **one** password to show for 15 seconds, only inside an **unlock window**: `vault_unlock` runs the device owner check (Face ID, Touch ID, Hello, passcode; fails closed where there is none) and opens the window for 120 seconds; leaving the Passwords page closes it. A call outside the window is the `vault-locked` error;
- ask how many logins match the page's site (`vault_count_for_page`, a number, no unlock) to decide whether to show Fill;
- delete one login, or everything (the file and the key).

Nothing here is reachable from a site webview: the commands are shell commands, the native calls they make are Rust-only.

## Fill

Tapping *Fill login* in the page tools unlocks, then `vault_fill` puts the login in the page in front. Before any password is sent, `fill::allowed` requires a **secure (`https`) page** whose origin is the login's origin, or whose registrable domain equals the login's and whose login origin is also `https`; `http` pages and other sites get nothing. The script (`fill.js`) then checks `location.origin` equals the origin Rust used, so a page that navigated between the tap and the fill gets nothing. It sets one username field (the nearest visible text, email or phone field before the password field) and one visible password field, fires `input` and `change`, and **submits nothing** (invariant 7: the person taps the site's own button). It returns two booleans and never a value. Values reach the script as JSON strings. A fill is one tap by the person; no feature fills unasked.

Late fields: `vault_fill` tries up to 4 times, 500 ms apart, until the password field is filled or the page has left the checked origin, so a page that builds its login fields late, or shows the password field only after the username step, still gets its login. Frames: `fill.js` also fills frames of the **same origin** as the page (read through `contentDocument`, checked with the frame window's `origin`); frames of other origins are out of reach and left alone.

Limits: the page can read what was filled, as with any autofill; a Mac, Windows or Linux build needs a working device owner check and, on Linux, a running Secret Service.

## Not done

Open tabs, extensions, cookies and sessions from the other browser are not imported (a session cannot be moved between browsers). Direct reading is not available where the system keeps other apps' folders out of reach (iOS, the stores' sandboxes); Firefox's and Safari's saved logins and Chrome's `v20` app-bound logins are not read directly and come through the browser's own password export.
