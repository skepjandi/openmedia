# Bundled blocklists

Filter lists compiled into the app binary and converted to Safari content-blocking rules at runtime
(see `docs/wiki/ad-blocking.md`). The app never downloads lists; they change only with an app
release. `scripts/update-blocklists.sh` refreshes them, and the weekly Blocklists workflow opens a
pull request when upstream changed.

| File                                                                      | List                                                                                    | Blocks                                                               | Group         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------- |
| `easylist.txt`                                                            | [EasyList](https://easylist.to/)                                                         | Ads                                                                  | `easylist`    |
| `easyprivacy.txt`                                                         | [EasyPrivacy](https://easylist.to/)                                                      | Trackers, analytics, tags                                            | `easyprivacy` |
| `ublock-privacy.txt`                                                      | [uBlock filters, Privacy](https://github.com/uBlockOrigin/uAssets)                       | Trackers EasyPrivacy misses                                          | `easyprivacy` |
| `ublock-filters.txt`                                                      | [uBlock filters](https://github.com/uBlockOrigin/uAssets)                                | Ads and annoyances EasyList misses                                   | `ublock`      |
| `ublock-badware.txt`                                                      | [uBlock filters, Badware risks](https://github.com/uBlockOrigin/uAssets)                 | Malware, scam and adware hosts                                       | `ublock`      |
| `ublock-resource-abuse.txt`                                               | [uBlock filters, Resource abuse](https://github.com/uBlockOrigin/uAssets)                | Cryptominers and similar                                             | `ublock`      |
| `ublock-unbreak.txt`, `ublock-quick-fixes.txt`                            | [uBlock filters, Unbreak and Quick fixes](https://github.com/uBlockOrigin/uAssets)       | Exceptions that undo breakage; carried by every group                | all           |
| `brave-specific.txt`                                                      | [Brave Specific](https://github.com/brave/adblock-lists)                                 | Brave-authored network and scriptlet rules                           | `brave`       |
| `brave-firstparty.txt`, `brave-firstparty-regional.txt`                   | [Brave Firstparty](https://github.com/brave/adblock-lists)                               | Ads and trackers served from the site's own host                     | `brave`       |
| `brave-ios-specific.txt`                                                  | [Brave iOS Specific](https://github.com/brave/adblock-lists)                             | iOS fixes, including YouTube ad fallback rules (iOS only)            | `brave`       |
| `brave-firstparty-cname.txt`                                              | [Brave Firstparty CNAME](https://github.com/brave/adblock-lists)                         | CNAME-cloaked tracker hosts                                          | `brave-cname` |
| `adguard-mobile.txt`                                                      | [AdGuard Mobile Ads](https://github.com/AdguardTeam/AdguardFilters)                      | Mobile ad networks                                                   | `mobile`      |
| `peter-lowe.txt`                                                          | [Peter Lowe's list](https://pgl.yoyo.org/adservers/)                                     | Ad and tracking servers                                              | `mobile`      |
| `openmedia-specific.txt`                                                  | OpenMedia                                                                               | Scriptlet rules for our own resources (not converted for WebKit)     | none          |
| `openmedia-youtube-ads.js`                                                | OpenMedia                                                                               | Removes YouTube ads from player, feed and Shorts data                | none          |
| `openmedia-link-cleaner.js`                                               | OpenMedia                                                                               | Cleans a link when the user follows it                               | none          |
| `brave-query-filter.json`, `brave-clean-urls.json`, `brave-debounce.json` | [Brave link-cleaning data](https://github.com/brave/adblock-lists)                       | Tracking parameters and redirect-tracker addresses                   | none          |
| `brave-resources.json`                                                    | [Brave adblock resources](https://github.com/brave/adblock-resources)                    | Scriptlet code referenced by filter rules                            | none          |

A group is one WebKit content-rule list. Exceptions only apply inside their own list, which is why
the Unbreak lists are copied into every group. EasyList, EasyPrivacy, AdGuard Mobile and Peter
Lowe's list are fetched from their current published version and keep their upstream header
(`Version`, `Last modified`); the uBlock files, the Brave lists and the resource bundle are pinned
to the revisions at the top of `scripts/update-blocklists.sh`. Downloads are normalized to LF line
endings so that list ids stay stable. Only default, zero permissions are used for scriptlets;
privileged scriptlets are not enabled.

Measured and left out: EasyList Cookie (Fanboy Cookiemonster), AdGuard Base, AdGuard Tracking
Protection, Hagezi Pro, URLhaus and Brave Social. See `docs/wiki/ad-blocking.md#not-built`.

## License

EasyList and EasyPrivacy are dual-licensed by the EasyList authors under
[CC BY-SA 3.0 and GPLv3](https://easylist.to/pages/licence.html). The uBlock lists are published
under the uAssets licence (`LICENSE` in [uBlockOrigin/uAssets](https://github.com/uBlockOrigin/uAssets))
and the AdGuard list under the AdguardFilters licence (`LICENSE` in
[AdguardTeam/AdguardFilters](https://github.com/AdguardTeam/AdguardFilters)); both are named in
the list headers, and both are believed to be GPLv3 **[INFERENCE: the licence files were not
read]**. Peter Lowe's list is published for free use by [pgl.yoyo.org](https://pgl.yoyo.org/adservers/).
Brave list, link-cleaning data and resource data are MPL-2.0. All are redistributed unmodified, as
data, with attribution here. The project license is MPL-2.0 (`LICENSE`); confirm the uBlock and
AdGuard terms before the first public release.
