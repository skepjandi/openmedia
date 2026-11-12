import { useCallback, useEffect, useRef, useState } from "react";
import { isFavoriteSite, toggleSiteFavorite } from "../../shared/favorites";
import { library } from "../../shared/ipc";
import { registrableDomain } from "../../shared/site";
import { useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import { SiteTile } from "../../shared/SiteTile";
import {
  bundledIconForHosts,
  faviconPageUrlForHost,
  useIconForUrl,
  setIconCache,
} from "../../shared/siteIcons";
import { Screen } from "../../shared/Screen";
import { Spinner } from "../../shared/Spinner";
import { Group, primaryBlockButton, field, quietBlockButton, quietButton } from "../settings/ui";
import {
  recipeLibrary,
  type LibraryItem,
  type LibraryListing,
  type LibraryTag,
  type RecipePreview,
} from "./ipc";
import {
  FILTER_TAGS,
  backTarget,
  defaultFilter,
  knownTags,
  platformTag,
  toggleTag,
  visibleItems,
  type LibraryView,
} from "./logic";
import { RecipeReview } from "./RecipeReview";

const TAG_LABELS: Record<LibraryTag, MessageKey> = {
  official: "library.tag.official",
  community: "library.tag.community",
  mobile: "library.tag.mobile",
  desktop: "library.tag.desktop",
  hub: "library.tag.hub",
};

const iconRequests = new Map<string, Promise<void>>();

function fetchLibraryIcon(url: string): void {
  const host = new URL(url).hostname;
  const key = registrableDomain(host);
  if (iconRequests.has(key)) return;
  const request = library
    .refreshIcons([url])
    .then(setIconCache)
    .catch(() => {})
    .finally(() => iconRequests.delete(key));
  iconRequests.set(key, request);
}

export function LibraryScreen() {
  const open = useApp((s) => s.sheet === "library");
  return open ? <LibraryBody /> : null;
}

function LibraryBody() {
  const closeSheet = useApp((s) => s.closeSheet);
  const t = useT();
  const [view, setView] = useState<LibraryView>({ kind: "list" });
  const [listing, setListing] = useState<LibraryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(() =>
    defaultFilter(platformTag(navigator.userAgent, navigator.maxTouchPoints)),
  );

  const refresh = useCallback(
    () =>
      recipeLibrary
        .list()
        .then((next) => {
          setError(null);
          setListing(next);
        })
        .catch((failure: unknown) => setError(describeError(failure, t))),
    [t],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const back = () => {
    const target = backTarget(view);
    if (target === "close") closeSheet();
    else setView(target);
  };

  const detailItem =
    view.kind === "detail" ? listing?.items.find((item) => item.id === view.id) : undefined;

  return (
    <Screen title={t("library.title")} closeLabel={t("common.back")} onClose={back} back>
      {view.kind === "list" && (
        <ListView
          listing={listing}
          filter={filter}
          query={query}
          onQuery={setQuery}
          onToggleTag={(tag) => setFilter((current) => toggleTag(current, tag))}
          error={error}
          onRetry={() => {
            setError(null);
            void refresh();
          }}
          onOpen={(item) => setView({ kind: "detail", id: item.id })}
        />
      )}
      {view.kind === "detail" && detailItem && (
        <DetailView
          item={detailItem}
          onChanged={async () => {
            await refresh();
            setView({ kind: "list" });
          }}
        />
      )}
      {view.kind === "detail" && !detailItem && (
        <p className="px-1 text-sm text-paper/55">{t("library.loading")}</p>
      )}
    </Screen>
  );
}

interface ListViewProps {
  listing: LibraryListing | null;
  filter: ReadonlySet<LibraryTag>;
  query: string;
  onQuery: (query: string) => void;
  onToggleTag: (tag: LibraryTag) => void;
  error: string | null;
  onRetry: () => void;
  onOpen: (item: LibraryItem) => void;
}

function ListView({
  listing,
  filter,
  query,
  onQuery,
  onToggleTag,
  error,
  onRetry,
  onOpen,
}: ListViewProps) {
  const t = useT();
  const items = listing ? visibleItems(listing.items, filter, query) : [];

  return (
    <div className="flex flex-col gap-5">
      <p className="px-1 text-[13px] leading-snug text-paper/50">{t("library.note")}</p>
      {error && (
        <div className="flex flex-col items-start gap-3 px-1">
          <p className="text-sm text-paper/70">{error}</p>
          <button type="button" onClick={onRetry} className={quietButton}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {!error && listing === null && <Spinner className="px-1" label={t("library.loading")} />}
      <input
        type="search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        aria-label={t("library.search")}
        placeholder={t("library.search")}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={field}
      />
      <div role="group" aria-label={t("library.filters")} className="flex flex-wrap gap-2 px-1">
        {FILTER_TAGS.map((tag) => (
          <button
            key={tag}
            type="button"
            aria-pressed={filter.has(tag)}
            onClick={() => onToggleTag(tag)}
            className={`rounded-full border px-3.5 py-1.5 text-sm font-medium ${
              filter.has(tag)
                ? "border-accent bg-accent text-on-accent"
                : "border-hair text-paper/75"
            }`}
          >
            {t(TAG_LABELS[tag])}
          </button>
        ))}
      </div>
      {listing && listing.items.length === 0 && (
        <p className="px-1 text-sm text-paper/55">{t("library.empty")}</p>
      )}
      {listing && listing.items.length > 0 && items.length === 0 && (
        <p className="px-1 text-sm text-paper/55">
          {t(query.trim() ? "library.searchNone" : "library.noMatch")}
        </p>
      )}
      {items.length > 0 && (
        <Group>
          {items.map((item) => (
            <ItemRow key={item.id} item={item} onOpen={() => onOpen(item)} />
          ))}
        </Group>
      )}
    </div>
  );
}

function ItemRow({ item, onOpen }: { item: LibraryItem; onOpen: () => void }) {
  const t = useT();
  const iconUrl = item.hosts.map(faviconPageUrlForHost).find(Boolean);
  const fetched = useIconForUrl(iconUrl ?? "", []);
  const icon = bundledIconForHosts([item.homepage, ...item.hosts]) ?? fetched;
  const row = useRef<HTMLButtonElement>(null);
  const state = item.installedVersion
    ? t(item.updateAvailable ? "library.update" : "library.added")
    : null;

  useEffect(() => {
    const element = row.current;
    if (!element || !iconUrl || icon) return;
    const load = () => fetchLibraryIcon(iconUrl);
    if (typeof IntersectionObserver === "undefined") {
      load();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        load();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [icon, iconUrl]);

  return (
    <button
      ref={row}
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-paper/[0.05]"
    >
      <SiteTile name={item.name} icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium">{item.name}</span>
        <span className="block truncate text-sm text-paper/55">
          {t("library.by", { author: item.author })}
        </span>
        <span className="mt-0.5 block text-sm leading-snug text-paper/55">{item.summary}</span>
        {item.hosts.length > 0 && (
          <span className="mt-0.5 block truncate text-xs text-paper/45">
            {item.hosts.join(", ")}
          </span>
        )}
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <TagBadges tags={item.tags} />
        </span>
      </span>
      {state && <span className="shrink-0 text-sm text-accent">{state}</span>}
    </button>
  );
}

function TagBadges({ tags }: { tags: readonly string[] }) {
  const t = useT();
  return knownTags(tags).map((tag) => (
    <span
      key={tag}
      className={`rounded-full border px-2 py-0.5 text-xs ${
        tag === "official" ? "border-accent text-accent" : "border-hair text-paper/60"
      }`}
    >
      {t(TAG_LABELS[tag])}
    </span>
  ));
}

interface DetailViewProps {
  item: LibraryItem;
  onChanged: () => Promise<void>;
}

function DetailView({ item, onChanged }: DetailViewProps) {
  const loadSites = useApp((s) => s.loadSites);
  const setSiteFavorite = useApp((s) => s.setSiteFavorite);
  const incognitoActive = useApp((s) => s.incognito.active);
  const incognitoFavorites = useApp((s) => s.incognito.favorites);
  const saveIncognitoFavorites = useApp((s) => s.saveIncognitoFavorites);
  const t = useT();
  const [preview, setPreview] = useState<RecipePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    recipeLibrary
      .preview(item.id)
      .then((next) => current && setPreview(next))
      .catch((failure: unknown) => current && setError(describeError(failure, t)));
    return () => {
      current = false;
    };
  }, [item.id, t]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await loadSites();
      await onChanged();
    } catch (failure) {
      setError(describeError(failure, t));
      setBusy(false);
    }
  };

  /**
   * A first add also stars the site; an update leaves the favorites as the user set them. In
   * incognito the site goes into the incognito favorites and the recipe is kept out of the
   * normal set: its normal switches are turned off, while the incognito set starts from the
   * recipe's defaults.
   */
  const install = async () => {
    const firstAdd = !item.installedVersion;
    await recipeLibrary.install(item.id);
    if (!firstAdd) return;
    if (!incognitoActive) {
      await setSiteFavorite(item.id, true);
      return;
    }
    const sites = await library.getSites(true);
    const site = sites.find((entry) => entry.recipeId === item.id);
    if (site?.homepage && !isFavoriteSite(incognitoFavorites, site.homepage)) {
      await saveIncognitoFavorites(toggleSiteFavorite(incognitoFavorites, site.homepage));
    }
    for (const option of site?.options ?? []) {
      await library.setSiteOption(item.id, option.id, false, false);
    }
  };

  const canAdd = !item.installedVersion || item.updateAvailable;

  return (
    <div className="flex flex-col gap-5">
      <div className="px-1">
        <h2 className="text-xl font-semibold">{item.name}</h2>
        <p className="mt-1 text-sm leading-snug text-paper/70">{item.summary}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <TagBadges tags={item.tags} />
        </div>
      </div>
      {(canAdd || item.installedVersion) && (
        <div className="flex gap-3">
          {canAdd && (
            <button
              type="button"
              disabled={!preview || busy}
              onClick={() => void run(install)}
              className={`flex-1 ${primaryBlockButton}`}
            >
              {t(item.installedVersion ? "library.update" : "library.add")}
            </button>
          )}
          {item.installedVersion && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => recipeLibrary.uninstall(item.id))}
              className={`flex-1 ${quietBlockButton}`}
            >
              {t("common.remove")}
            </button>
          )}
        </div>
      )}
      {error && <p className="px-1 text-sm text-paper/70">{error}</p>}
      {preview === null && !error && <Spinner className="px-1" label={t("library.loading")} />}
      {preview && <RecipeReview preview={preview} />}
    </div>
  );
}
