# Recipe Library and Sharing

> **Status: Implemented (2026-11-13); not run on a device, and the GitHub login and pull request not verified against real GitHub.** Replaces the recipe marketplace (signed Cloudflare catalog, ratings, comments, install review), which is removed. Implementation: `src-tauri/src/recipes/bundled.rs` and `share/` in the app, [`openmedia-worker`](https://github.com/skepjandi/openmedia-worker) for the GitHub login and the pull request. The remove-everything decision is in the [Roadmap](./roadmap.md#decision-log).

Recipes reach people one way:

1. **The recipe library and GitHub sharing.** Every recipe the project ships is inside the app. A user who made a recipe and wants it in the app for everyone proposes it as a **pull request** on the OpenMedia repository, through a GitHub login handled by the Worker. Maintainers review and merge it; it ships in the next release.

Both end in the same place for the person receiving a recipe: a recipe with `origin: imported`, reviewed rule by rule before anything applies.

## The library

- **Where recipes live.** `recipes/official/*.json` (maintainers; ids `market.official.<site>`) and `recipes/community/*.json` (merged pull requests; ids `market.<slug>`) are compiled into the binary by `build.rs`. The `market.` prefix is a legacy: it is kept so recipes installed by earlier versions, and the switches saved against their ids, keep working.
- **Adding.** *Add* copies a bundled recipe into `<app_data>/recipes/` (the same local files as the user's own recipes) after the usual validation. A fresh install has none added; first-run onboarding offers the official recipes for the platform and the quick-access favorites made from them. *Update* appears when the bundled version is higher than the added one, which happens after an app update. Removing deletes the local copy.
- **Tags.** Platform tags (`mobile`, `desktop`) are inside the recipe. `official` / `community` come from the directory, `hub` from the recipe having hub tabs. **Subject categories** (`ai`, `archive`, `education`, `games`, `music`, `news`, `podcasts`, `productivity`, `radio`, `reference`, `search`, `shopping`, `social`, `tech`, `travel`, `video`) come from `recipes/categories.json`, which maps each bundled recipe id to one to three of them; a test requires an entry for every bundled recipe and refuses unknown or stale ones. The list shows platform tags, then categories, then the origin tag, then `hub`. The library's *Filters* button opens a dialog with a section per kind (source, platform, type, category), a count on each chip, and *Clear all*; chips of one kind widen the match, kinds narrow each other. A tag is a label, not a trust level.
- **Parsed as imported.** Every bundled file goes through the shared-recipe path, which forces `origin: imported`, so scripts in a bundled recipe must pass the [Script Policy](./script-policy.md) exactly like an upload would have. A bundled file that fails to parse fails `cargo test`; at runtime it is skipped.
- **No network.** The library never talks to a server. Recipes change only when the app does.

## Sharing a recipe

### What the person sees

Written for people who have never used GitHub: one thing per screen, no technical words.

1. **Share your recipe with everyone.** Pick one of your own recipes, describe it in a few words, tap *Continue with GitHub*. Three plain lines sit under the button: you need a free GitHub account; your recipe and your GitHub username are sent to the OpenMedia team; everyone gets it in an update after the team has reviewed and approved it.
2. **Sign in.** The browser opens GitHub. The person signs in and approves, then comes back. The app says what to do and has a *Cancel* button.
3. **Sending.** A short *Sending your recipe...*.
4. **Done.** *Thank you! Your recipe will be available in the next update after review and approval.* A quiet *See it on GitHub* link and a *Done* button.
5. **If something is wrong** one friendly sentence and *Try again*: the GitHub account is too new (try again in a few days), too many shares today (try tomorrow), the recipe uses something that cannot be shared yet (and what), no connection, or a generic failure.

There is no name, id or version to type: the app derives a unique id from the recipe name, so every share is a new recipe and can never overwrite an existing one.

### How it works

```mermaid
sequenceDiagram
  participant U as User
  participant A as App (Rust)
  participant W as Worker
  participant G as GitHub
  U->>A: Continue with GitHub (summary)
  A->>A: validate as imported (script policy)
  A->>W: POST /v1/shares {recipe, summary}
  W-->>A: id, pollToken, loginUrl
  A->>U: opens loginUrl in the system browser
  U->>G: signs in, approves read:user
  G->>W: /v1/github/callback?code&state
  W->>G: user lookup; branch, file and pull request via the GitHub App
  A->>W: GET /v1/shares/{id} (pollToken)
  W-->>A: done, prUrl
  A->>U: link to the pull request
```

- **The app** derives the id (`market.<name>-<4 random characters>`), checks the recipe first, exactly as the library and the Worker will (including the script policy), so a refused recipe never leaves the device. It sends the recipe and a one-line summary and keeps the poll token in memory only. The shell never sees the token, the login address or any GitHub token. Sharing has no Pro gate.
- **The Worker** validates again, then sends the user to GitHub with the scope `read:user` only: the login proves who the person is, it gives the Worker no write access to anything of theirs. After the callback it discards the user's token and creates the pull request with its own GitHub App installation token: branch `recipe/<slug>-<version>-<random>`, file `recipes/community/<slug>.json`, commit credited to the user with a `Co-authored-by` trailer, and a pull request whose body names `@login`, the summary, the sites it covers, whether it contains scripts and a reviewer checklist.
- **Limits.** The GitHub account has to be at least 7 days old; 5 shares per account per rolling day; a per-address rate limit; sessions expire after 15 minutes. The Worker also refuses to touch an existing community file unless the version is higher. `market.official.*` ids are refused.
- **Review.** A person reads the pull request. Continuous integration runs the recipe validation (`.github/workflows/recipes.yml`). Reviewers check what a checklist can: that it does what the summary says, hosts and selectors are reasonable, no security UI is hidden, scripts are within the policy and make sense.

### Privacy

The app contacts the Worker only when the user taps *Share on GitHub*; the Worker sees the recipe the user chose to share, their GitHub login, numeric id and account creation date, and the connection. It stores the pending session (the recipe, hashed tokens, the result) for at most 15 minutes and a counter row (GitHub id, time) for 2 days. After a first sign-in it also keeps, for 90 days or until the user taps *Sign out*, the SHA-256 of a random remember token plus the GitHub login, numeric id and account creation date. The app keeps the token (with the login, to show who is signed in) in the OS secure store and sends it as `X-Remember-Token`; the Worker then shares as that account without opening the browser. It never stores a GitHub token. It stores no IP address and does not use Workers Logs. GitHub sees the login and the pull request like any other. Nothing about this reaches the Worker unless the user shares.

## Threat model

| Threat | Control |
|---|---|
| A malicious or careless recipe is merged | Human review of a public pull request; validation and the script policy in CI and again in the app (every bundled file is parsed as `imported`); the app shows every rule and script before a recipe is added; a bad recipe is removed by the next release, and the bundled version is what Update offers |
| A script steals data | The [Script Policy](./script-policy.md) has no way to send data anywhere; nothing runs before the user adds the recipe; local scripts the user's own assistant writes are shown with their powers first |
| Abuse of the share endpoint (spam pull requests) | GitHub login, 7-day account age, 5 per account per day, per-address rate limit, size cap, 15-minute sessions, maintainers can close pull requests and block accounts on GitHub |
| The Worker is compromised | It holds a GitHub App key that can write only to the one repository and cannot merge into a protected branch; merged content is still reviewed by a person and re-validated by the app; it never has a user write token and never holds one after the callback; no secret reaches the app |
| A page or the shell talks to the Worker | Only Rust calls it. The commands are shell-only app commands, none takes a URL or token from the shell, and the Worker address is a build constant (`OPENMEDIA_SHARE_URL`) |
| Someone submits under another person's name | The pull request names the authenticated GitHub login and credits that login in the commit trailer; `meta.author` in the file is free text the reviewer sees |
| A recipe overwrites an official one | `market.official.*` ids are refused by the app, the Worker and the bundled loader (and by CI for `recipes/community`) |

## Store policy

Recipes are no longer downloaded from a server at runtime: they are part of the release the store reviews, like any other app content, and user-generated content now reaches the app only through a reviewed pull request and an app release. That removes the user-generated-content moderation and the downloaded-code concerns of the marketplace design (Apple 2.5.2 for downloaded scripts, UGC filtering for comments). Scripts in bundled recipes are still code that changes the behaviour of web pages the user visits: they run in the site web view, pass the [Script Policy](./script-policy.md), and ship inside the signed binary. [INFERENCE] This is the posture of an app that ships built-in site customizations; it has not been through store review.

## Not in scope

Runtime download of recipes or updates outside an app release, ratings, comments, install counts, accounts, payments for recipes, a moderation API. If recipe updates ever need to ship faster than the app, the over-the-air web-bundle channel in [Updates](./updates.md) is the place to look, not a catalog.

## See also

[Recipe Format](./recipe-format.md) · [Script Policy](./script-policy.md) · [Security](./security.md) · [Roadmap](./roadmap.md)
