# Contributing to OpenMedia

Read [AGENTS.md](AGENTS.md) first. It applies to humans and AI agents alike.

1. Read the relevant [wiki](docs/wiki/index.md) page before changing code.
2. Branch from `origin/main` (ideally in a git worktree under `.worktrees/`). Never commit to `main`.
3. Use conventional-commit prefixes (`feat(engine):`, `fix(ai):`, `docs(wiki):`).
4. All checks must pass before opening a PR:

```bash
yarn verify   # ts:check, lint, format:check, test, cargo fmt, clippy -D warnings, cargo test
```

5. Add a `CHANGELOG.md` entry; update the wiki if behavior or architecture changes.
6. Never commit secrets, and scrub personal data from fixtures.

## Adding a recipe

**In the app (everyone):** Settings > Recipe library > Share on GitHub. You sign in with a free GitHub account, the OpenMedia Worker opens a pull request for you, and the recipe is available in the next update after review and approval.

**By hand (developers):** add `recipes/community/<name>.json` (id `market.<name>`, never `market.official.*`) and open a pull request. The recipe must pass the validator and the [script policy](docs/wiki/script-policy.md) (CI runs `.github/workflows/recipes.yml`); it needs `tags`, a `meta.summary` of up to 140 characters and a `meta.homepage` its own `match` patterns cover. Reviewers check that it does what the summary says, that the sites and selectors are reasonable, that no security UI (login, payment, warnings) is hidden, and that any script is within the policy and makes sense. Official recipes (`recipes/official/`) also need DOM fixtures in `recipes/fixtures/<site>/`.

## License

By contributing you agree your contributions are licensed under [MPL-2.0](LICENSE). Each source file is covered by the license via the repository `LICENSE`; no per-file header is required.
