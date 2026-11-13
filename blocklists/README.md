# Bundled blocklists

Filter lists compiled into the app binary and converted to Safari content-blocking rules at runtime
(see `docs/wiki/ad-blocking.md`). The app never downloads lists; they change only with an app release.

| File                       | List                                                                 | Blocks                                              |
| -------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| `easylist.txt`             | [EasyList](https://easylist.to/)                                      | Ads                                                 |
| `easyprivacy.txt`          | [EasyPrivacy](https://easylist.to/)                                   | Trackers, analytics, tags                           |
| `brave-specific.txt`       | [Brave Specific](https://github.com/brave/adblock-lists)              | Brave-authored network and scriptlet rules          |
| `brave-ios-specific.txt`   | [Brave iOS Specific](https://github.com/brave/adblock-lists)          | iOS fixes, including YouTube ad fallback rules      |
| `brave-resources.json`     | [Brave adblock resources](https://github.com/brave/adblock-resources) | Scriptlet code referenced by filter rules            |

The iOS-specific list is bundled only for iOS. The Brave Specific snapshot is pinned to
`a190fe07fe27b697dc796d54a54b58dfd75e7b1c`; the iOS-specific list uses the same revision. The
resource bundle is pinned to `6da9b247c3368baa8b4f24cd02046e18702a6527`. Both upstream repositories
use MPL-2.0. The snapshots are redistributed unmodified with attribution here. Only default, zero
permissions are used; privileged scriptlets are not enabled.

Each EasyList file keeps its upstream header, including `Version`, `Last modified` and `Licence`.

## License

EasyList and EasyPrivacy are dual-licensed by the EasyList authors under
[CC BY-SA 3.0 and GPLv3](https://easylist.to/pages/licence.html). They are redistributed unmodified,
as data, with attribution here. Brave list and resource data are MPL-2.0. The project license is
still undecided (roadmap, open question 5); decide it with these licenses in view before the first
public release.

## Updating

Run `scripts/update-blocklists.sh` from the repository root. It refreshes EasyList/EasyPrivacy and
downloads the Brave snapshots from the pinned revisions above. To update Brave data, review upstream
changes, change the two commit SHAs in the script, run it, inspect the diff and rerun the focused
Rust adblock tests. No updater runs in the app.
