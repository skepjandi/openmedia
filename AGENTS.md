# OpenMedia — Agent Rules

> Rules for AI coding agents working in this repository.

OpenMedia is a Tauri v2 app (desktop + iOS + Android) that loads any website in an embedded webview and lets the user reshape it: hide Instagram Reels, strip YouTube Shorts, remove any element on any site. Customizations are declarative **recipes**. An AI assistant generates and repairs recipes using a key the user supplies (BYOK). **No server of ours is needed to use the app.** The only one we operate is the opt-in recipe marketplace (Cloudflare), which can never apply anything to the device by itself.

## Read the Wiki First

**Before touching any code, read the relevant wiki page(s).** The wiki (`docs/wiki/`) is the canonical reference for architecture, the recipe format, the AI pipeline, and the security model.

- Starting anything? → read `docs/wiki/architecture.md` and `docs/wiki/roadmap.md` (which phase are we in?)
- Touching recipes, selectors, rule types? → read `docs/wiki/recipe-format.md`
- Touching the injected page script, snapshots, picker? → read `docs/wiki/site-runtime.md`
- Touching LLM providers, prompts, API keys, snapshot redaction? → read `docs/wiki/ai-assistant.md`
- Touching webview creation, capabilities, IPC, secrets, anything a website can reach? → read `docs/wiki/security.md`
- Touching anything platform-specific (iOS/Android plugin, desktop child webview)? → read `docs/wiki/platform-support.md`
- Wondering why a decision was made or what the competition does? → `docs/wiki/roadmap.md` (decision log) and `docs/wiki/prior-art.md`

If the wiki is wrong or missing, fix it first — then make your code change. See the wiki accuracy rule below.

## Worktrees (ALWAYS)

**All agent work — fixes, features, refactors, even small edits — happens inside a git worktree. Never edit files in the main worktree's working tree directly.**

Multiple agent sessions may run concurrently on different branches. The main worktree is shared; editing it directly causes races where one agent's uncommitted changes block or corrupt another's work.

```bash
# From the repo root (the main worktree):
git fetch origin
git worktree add -b <type>/<scope>-<slug> .worktrees/<scope>-<slug> origin/main
# e.g.  git worktree add -b feat/recipe-schema .worktrees/recipe-schema origin/main

# Always under .worktrees/ at the repo root (gitignored) — never /tmp or ~.
ln -sfn "$(pwd)/node_modules" .worktrees/<scope>-<slug>/node_modules   # once node_modules exists
```

- **Main must stay clean.** No uncommitted changes, no staged files. Remove the worktree as soon as its branch is merged (`git worktree remove <path>`), then confirm `git status` in main is empty.
- **One worktree per branch.** Always branch from `origin/main`, never from another worktree's branch.
- **Rust `target/` is per-worktree and large.** Set `CARGO_TARGET_DIR` to a shared directory outside the repo if disk is tight; never commit it.
- **Coordinate before touching shared files** (`src-tauri/capabilities/*`, `tauri.conf.json`, recipe schema). Check `git worktree list` and the other worktrees' `git status` first.

## Testing

All checks must pass before pushing. `yarn verify` runs the whole contract; the pieces are:

```bash
yarn ts:check                                      # TypeScript strict compile
yarn lint                                          # ESLint
yarn format:check                                  # Prettier
yarn test                                          # Vitest (frontend + engine)
yarn check:rust                                    # cargo fmt --all --check, clippy --workspace -D warnings, cargo test --workspace
```

- **Never push failing checks.** CI runs `lint`; the pre-commit hook runs `format:check` and `test`. `ts:check` and the Rust checks are on you; run `yarn verify` before pushing.
- New module → test file mirroring the source path. Rust unit tests live beside the code (`#[cfg(test)]`); integration tests in `src-tauri/tests/`.
- **Recipe rules are tested against DOM fixtures** (`recipes/fixtures/<site>/`), not live sites. An official recipe (`recipes/official/`) without a fixture test does not ship.
- Mock the network. LLM provider tests use recorded request/response fixtures; never call a real provider in tests and never put a real key in a fixture.
- Do not use screenshots or LLM visual inspection as test evidence. Verify behavior programmatically. Manual on-device testing (iOS/Android/desktop) is the user's; state clearly in the PR what remains unverified.

## Self-Documenting Code

- Clear names; no comments explaining obvious behavior.
- TypeScript strict mode — no `any` without justification.
- Rust: no `unwrap()`/`expect()` outside tests; propagate typed errors (`thiserror`). `clippy -D warnings` is zero-tolerance.
- Keep functions short and focused.
- **Never keep deprecated code.** When a Tauri/plugin/library API is deprecated, migrate immediately in the same change.
- **Zero tolerance for lint-blocking issues.** Unused vars/imports, empty functions/blocks, `prefer-const`, useless escapes — fix them on every change. Prefix intentionally unused parameters with `_`.

## Architecture Invariants

Violating any of these is a bug regardless of whether tests pass. Details in `docs/wiki/security.md`.

1. **No backend beyond the marketplace; no telemetry.** No analytics, no crash reporting, no identifiers that leave the device except the two marketplace ones named in (c). The only network destinations are (a) the sites the user opens, (b) the LLM endpoint the user configured, (c) the opt-in recipe marketplace on Cloudflare (`docs/wiki/marketplace.md`), reached only on user action, HTTPS only, no cookies, no account; it receives a random per-install device token (ratings, reports) and, only on Pro-gated actions (upload, comments), the RevenueCat anonymous app-user ID, which the Worker stores only as a SHA-256 hash and the shell never sees, (d) static GitHub releases, (e) RevenueCat, only from the in-repo billing plugin, for purchase validation and restore (anonymous app-user ID, no account; see `docs/wiki/paywall.md`). The marketplace is untrusted: everything it returns is verified against a signature key compiled into the app and validated again in Rust. The signing key is a Cloudflare Worker secret, so a valid signature means the catalog came from the Worker, not that a recipe is benign; submissions are checked automatically, held for 14 days and published automatically, with no person reviewing them (an open store-policy risk, `docs/wiki/marketplace.md#store-policy`). Do not add any other SDK that phones home.
2. **API keys live only in the OS secure store and are read only in Rust.** Never pass a key to any webview, never log it, never write it to recipes, exports, settings JSON, error messages, or test fixtures.
3. **Site webviews are hostile.** They load arbitrary third-party code. They get no Tauri IPC except the single narrowly-scoped bridge command defined in `security.md`. Adding any command, event, or capability reachable from a site webview needs a `security.md` update and explicit justification in the PR.
4. **AI output is untrusted input.** Validate it against the recipe schema in Rust before it touches a webview. Script-type rules require explicit per-recipe user confirmation; the AI never gets a path to apply one silently.
5. **Site knowledge lives in recipes, not code.** No `if (host === "instagram.com")` in the engine, shell, or Rust. Site-specific behavior is data.
6. **Snapshots are redacted before they leave the device,** and the user can preview exactly what will be sent.
7. **Customize, never automate.** The engine changes what the user sees. It does not click, like, post, follow, scrape at scale, or act on the user's behalf on a site.
8. **Profiles are isolated.** Cookies/storage for one profile must never be readable by another or by the app shell.

## Second-Order Thinking Before Every Change

**Never fix something without understanding its ripples.**

- **What does this code talk to?** Find callers and consumers. The recipe schema is consumed by Rust validation, the TS editor UI, the engine, the AI prompt, and every official recipe.
- **What does this code touch?** Webview lifecycle, the injected engine, the bridge, and the key store are high-coupling areas. Trace the full call chain first.
- **Symptom or cause?** If a site-breakage fix needs a new special case in the engine, the recipe format is probably missing a primitive. Fix the format.
- **Does it work on every platform?** Desktop uses a child webview; mobile uses a native plugin. A change to the `SiteView` contract must be implemented on both.
- **Is it reversible?** Recipe schema changes need a version bump and a migration; users' saved recipes must keep loading.

If uncertain about impact — **stop and ask**.

## Git Discipline

- **Never commit or push directly to `main`.** Every change goes through a branch and a pull request.
- Atomic commits, imperative mood, conventional-commit prefixes (`feat(engine):`, `fix(ai):`, `docs(wiki):`).
- No `node_modules/`, `target/`, `.DS_Store`, `.env`, build artifacts, or signing material.
- Branch per feature, rebase before merging.

## Releasing

**Use `yarn release`; never hand-run store builds or export signing variables.** Full guide: `docs/wiki/store-builds.md#releasing-yarn-release`.

- `yarn release doctor` first. It lists what is missing and the exact fix. Do not guess identity names, profile paths or passwords, and never search the disk for certificate passwords.
- `yarn release ship <patch|minor|major|x.y.z>` is the whole release: version PR from a worktree, merge, build ios/android/macos from `main`. Run it from a clean `main` checkout (the Android keystore is gitignored and only exists there). `yarn release` alone builds from the current checkout.
- Signing material (`.p12`, profiles, `.p8`) lives in the signing folder outside the repo (`~/Documents/openmedia-signing`, or `SIGNING_DIR`), its passwords in the gitignored `.env`. Never print them, commit them, or paste them in a PR or chat.
- The version and build numbers are edited only by `yarn release bump` (`scripts/lib/version.mjs`), which keeps `package.json` and `src-tauri/tauri.conf.json` equal.
- After a build, tell the user the artifact paths printed by the CLI and that nothing was uploaded or validated unless `--validate` ran.

## Wiki documentation

Two documentation surfaces:

- **`CHANGELOG.md`** (repo root) — single-PR fixes and narrow entries, grouped by date descending: title, area (conventional-commit prefix), 2–4 line summary, PR reference. Default location for any new fix or feature note.
- **GitHub Wiki** ([skepjandi/openmedia/wiki](https://github.com/skepjandi/openmedia/wiki)) — architecture, formats, security model, platform notes, roadmap. A new page is appropriate when a change crosses architectural boundaries or teaches contributors something about the system.

Editing the wiki: write the page in `docs/wiki/<name>.md` (source-controlled), add it to `docs/wiki/index.md`, open a PR. The sync workflow (`.github/workflows/sync-wiki.yml`) mirrors `docs/wiki/` → GitHub Wiki on every merge to `main`. Manual edits on the GitHub Wiki are overwritten on the next sync.

**Status banners.** While code does not exist, wiki pages describe the *intended* design and carry a `Status: Design` banner. When the code lands, the PR that lands it flips the banner to `Status: Implemented`, replaces intent with fact (real file names, real signatures), and records deviations in the roadmap decision log.

**Wiki accuracy is a living concern.** If a page is wrong — wrong file, signature, schema field, or behavior — fix it as part of your current work. This applies to every PR.

Architecture-level changes (new module, new rule type, new provider, new capability, new platform path) are not done until the wiki is updated.

## Data Safety

- **Never commit secrets:** API keys, `.env`, signing certificates/keystores (`*.jks`, `*.p12`, `*.mobileprovision`, `*.p8`), the Tauri updater private key, Apple/Google service credentials.
- `.env` is gitignored; use `.env.example` for templates.
- Fixtures captured from real sites must be scrubbed of personal content (names, handles, messages, tokens, cookies) before commit.
- Check `git diff` before committing.
- **The repository is public (open source).** Everything committed, every PR body, issue, changelog entry and doc is world-readable and permanent in history. Never include passwords, tokens, keys, certificate or profile contents, App Store Connect or Play service account files, or personal data (emails, home-directory usernames, private team or company names). Reference secrets by variable name only (`SIGNING_P12_PASSWORD`), never by value. Write docs and scripts so a stranger can follow them: no machine-specific paths except documented defaults, and release steps that need maintainer credentials say so.
