import { useCallback, useEffect, useRef, useState } from "react";
import { library } from "../../shared/ipc";
import { registrableDomain } from "../../shared/site";
import { appError, useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import { ProIcon } from "../../shared/icons";
import { SiteTile } from "../../shared/SiteTile";
import {
  bundledIconForHosts,
  faviconPageUrlForHost,
  useIconForUrl,
  setIconCache,
} from "../../shared/siteIcons";
import { Screen } from "../../shared/Screen";
import { GuideLink } from "../guides/GuideLink";
import { useEntitlementStore } from "../paywall/store";
import { Switch } from "../settings/Switch";
import {
  Group,
  Spinner,
  primaryButton,
  field,
  primaryBlockButton,
  quietBlockButton,
  quietButton,
} from "../settings/ui";
import {
  marketplace,
  type MarketItem,
  type MarketListing,
  type MarketTag,
  type RecipePreview,
  type ReportReason,
} from "./ipc";
import { BlockedView, CommentsSection } from "./Comments";
import {
  FILTER_TAGS,
  STAR_COUNT,
  backTarget,
  defaultFilter,
  formatRating,
  knownTags,
  platformTag,
  toggleTag,
  visibleItems,
  type MarketView,
} from "./logic";
import { RecipeReview } from "./RecipeReview";

const TAG_LABELS: Record<MarketTag, MessageKey> = {
  official: "market.tag.official",
  community: "market.tag.community",
  mobile: "market.tag.mobile",
  desktop: "market.tag.desktop",
  hub: "recipes.hub",
};

const REASONS: { reason: ReportReason; label: MessageKey }[] = [
  { reason: "harmful", label: "market.report.harmful" },
  { reason: "broken", label: "market.report.broken" },
  { reason: "misleading", label: "market.report.misleading" },
  { reason: "spam", label: "market.report.spam" },
  { reason: "other", label: "market.report.other" },
];

const iconRequests = new Map<string, Promise<void>>();

function fetchMarketplaceIcon(url: string): void {
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

/** Recipes other people made, checked automatically and listed after the hold period. Opened from Settings. */
export function MarketplaceScreen() {
  const open = useApp((s) => s.sheet === "marketplace");
  return open ? <MarketplaceBody /> : null;
}

function MarketplaceBody() {
  const closeSheet = useApp((s) => s.closeSheet);
  const loadSites = useApp((s) => s.loadSites);
  const t = useT();
  const [view, setView] = useState<MarketView>({ kind: "list" });
  const [listing, setListing] = useState<MarketListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(() =>
    defaultFilter(platformTag(navigator.userAgent, navigator.maxTouchPoints)),
  );
  const isPro = useEntitlementStore((s) => s.status === "pro");
  const openSheet = useApp((s) => s.openSheet);
  const marketplaceFocus = useApp((s) => s.marketplaceFocus);
  const clearMarketplaceFocus = useApp((s) => s.clearMarketplaceFocus);

  const refresh = useCallback(
    () =>
      marketplace
        .list()
        .then((next) => {
          setError(null);
          setListing(next);
          if (marketplaceFocus && !next.items.some((item) => item.id === marketplaceFocus)) {
            clearMarketplaceFocus();
          }
          if (next.withdrawn.length > 0) void loadSites();
        })
        .catch((failure: unknown) => setError(describeError(failure, t))),
    [clearMarketplaceFocus, loadSites, marketplaceFocus, t],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeView: MarketView =
    view.kind === "list" &&
    marketplaceFocus !== null &&
    listing?.items.some((item) => item.id === marketplaceFocus)
      ? { kind: "detail", id: marketplaceFocus }
      : view;

  const back = () => {
    const target = backTarget(activeView);
    if (marketplaceFocus) clearMarketplaceFocus();
    if (target === "close") closeSheet();
    else setView(target);
  };

  const detailItem =
    activeView.kind === "detail"
      ? listing?.items.find((item) => item.id === activeView.id)
      : undefined;

  return (
    <Screen title={t("market.title")} closeLabel={t("common.back")} onClose={back} back>
      {activeView.kind === "list" && (
        <div className="pb-3">
          <GuideLink slug="marketplace" />
        </div>
      )}
      {activeView.kind === "list" && (
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
          onShare={() => (isPro ? setView({ kind: "submit" }) : openSheet("paywall"))}
          onBlocked={() => setView({ kind: "blocked" })}
        />
      )}
      {activeView.kind === "detail" && detailItem && (
        <DetailView
          item={detailItem}
          onRated={() => void refresh()}
          onManageBlocked={() => setView({ kind: "blocked" })}
          onChanged={async () => {
            await refresh();
            setView({ kind: "list" });
          }}
        />
      )}
      {activeView.kind === "detail" && !detailItem && (
        <p className="px-1 text-sm text-paper/55">{t("market.loading")}</p>
      )}
      {activeView.kind === "submit" && <SubmitView />}
      {activeView.kind === "blocked" && <BlockedView />}
    </Screen>
  );
}

interface ListViewProps {
  listing: MarketListing | null;
  filter: ReadonlySet<MarketTag>;
  query: string;
  onQuery: (query: string) => void;
  onToggleTag: (tag: MarketTag) => void;
  error: string | null;
  onRetry: () => void;
  onOpen: (item: MarketItem) => void;
  onShare: () => void;
  onBlocked: () => void;
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
  onShare,
  onBlocked,
}: ListViewProps) {
  const t = useT();
  const isPro = useEntitlementStore((s) => s.status === "pro");
  const items = listing ? visibleItems(listing.items, filter, query) : [];

  return (
    <div className="flex flex-col gap-5">
      <p className="px-1 text-[13px] leading-snug text-paper/50">{t("market.note")}</p>
      {error && (
        <div className="flex flex-col items-start gap-3 px-1">
          <p className="text-sm text-paper/70">{error}</p>
          <button type="button" onClick={onRetry} className={quietButton}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {!error && listing === null && <Spinner label={t("market.loading")} />}
      {listing && listing.withdrawn.length > 0 && (
        <p className="px-1 text-sm text-paper/70">
          {t("market.withdrawn", { names: listing.withdrawn.join(", ") })}
        </p>
      )}
      <input
        type="search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        aria-label={t("market.search")}
        placeholder={t("market.search")}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={field}
      />
      <div role="group" aria-label={t("market.filters")} className="flex flex-wrap gap-2 px-1">
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
        <p className="px-1 text-sm text-paper/55">{t("market.empty")}</p>
      )}
      {listing && listing.items.length > 0 && items.length === 0 && (
        <p className="px-1 text-sm text-paper/55">
          {t(query.trim() ? "market.searchNone" : "market.noMatch")}
        </p>
      )}
      {items.length > 0 && (
        <Group>
          {items.map((item) => (
            <ItemRow key={item.id} item={item} onOpen={() => onOpen(item)} />
          ))}
        </Group>
      )}
      <div className="flex flex-col gap-3">
        <button type="button" onClick={onShare} className={quietBlockButton}>
          {t("market.share")}
          {!isPro && <ProIcon size={14} />}
        </button>
        <button type="button" onClick={onBlocked} className={quietBlockButton}>
          {t("market.comments.blocked")}
        </button>
        <CountingSwitch />
      </div>
    </div>
  );
}

function ItemRow({ item, onOpen }: { item: MarketItem; onOpen: () => void }) {
  const t = useT();
  const iconUrl = item.hosts.map(faviconPageUrlForHost).find(Boolean);
  const fetched = useIconForUrl(iconUrl ?? "", []);
  const icon = bundledIconForHosts([item.homepage, ...item.hosts]) ?? fetched;
  const row = useRef<HTMLButtonElement>(null);
  const state = item.installedVersion
    ? t(item.updateAvailable ? "market.update" : "market.added")
    : null;

  useEffect(() => {
    const element = row.current;
    if (!element || !iconUrl || icon) return;
    const load = () => fetchMarketplaceIcon(iconUrl);
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
          {t("market.by", { author: item.author })}
          {item.installs ? ` · ${t("market.addedBy", { count: item.installs })}` : ""}
        </span>
        <span className="mt-0.5 block text-sm leading-snug text-paper/55">{item.summary}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <TagBadges tags={item.tags} />
          <RatingText item={item} />
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

function RatingText({ item }: { item: MarketItem }) {
  const t = useT();
  return (
    <span className="text-xs text-paper/60">
      {formatRating(item.rating) ?? t("market.rating.none")}
    </span>
  );
}

/** Tap a star to rate; rating again replaces the earlier rating. */
function RatingControl({ item, onRated }: { item: MarketItem; onRated: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rate = async (stars: number) => {
    setBusy(true);
    setError(null);
    try {
      await marketplace.setRating(item.id, stars);
      onRated();
    } catch (failure) {
      setError(appError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-1">
      <p className="text-[13px] font-medium text-paper/60">{t("market.rate")}</p>
      <div className="flex gap-1">
        {Array.from({ length: STAR_COUNT }, (_, index) => index + 1).map((stars) => (
          <button
            key={stars}
            type="button"
            disabled={busy}
            aria-pressed={item.myRating === stars}
            aria-label={t("market.rateStars", { count: stars })}
            onClick={() => void rate(stars)}
            className={`grid size-10 place-items-center text-2xl ${
              item.myRating !== null && stars <= item.myRating ? "text-accent" : "text-paper/35"
            }`}
          >
            ★
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-paper/70">{error}</p>}
    </div>
  );
}

function CountingSwitch() {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    void marketplace.status().then((status) => setEnabled(status.countInstalls));
  }, []);

  if (enabled === null) return null;
  return (
    <Group>
      <Switch
        label={t("market.counting")}
        description={t("market.countingNote")}
        checked={enabled}
        onChange={(next) => {
          setEnabled(next);
          void marketplace.setCounting(next);
        }}
      />
    </Group>
  );
}

interface DetailViewProps {
  item: MarketItem;
  onChanged: () => Promise<void>;
  onRated: () => void;
  onManageBlocked: () => void;
}

function DetailView({ item, onChanged, onRated, onManageBlocked }: DetailViewProps) {
  const loadSites = useApp((s) => s.loadSites);
  const t = useT();
  const [preview, setPreview] = useState<RecipePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);

  useEffect(() => {
    let current = true;
    marketplace
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

  const report = async (reason: ReportReason) => {
    setError(null);
    try {
      await marketplace.report(item.id, reason);
      setReported(true);
    } catch (failure) {
      setError(describeError(failure, t));
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
          <RatingText item={item} />
        </div>
      </div>
      {(canAdd || item.installedVersion) && (
        <div className="flex gap-3">
          {canAdd && (
            <button
              type="button"
              disabled={!preview || busy}
              onClick={() => void run(() => marketplace.install(item.id))}
              className={`flex-1 ${primaryBlockButton}`}
            >
              {t(item.installedVersion ? "market.update" : "market.add")}
            </button>
          )}
          {item.installedVersion && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => marketplace.uninstall(item.id))}
              className={`flex-1 ${quietBlockButton}`}
            >
              {t("common.remove")}
            </button>
          )}
        </div>
      )}
      {error && <p className="px-1 text-sm text-paper/70">{error}</p>}
      {preview === null && !error && <Spinner label={t("market.loading")} />}
      {preview && <RecipeReview preview={preview} />}
      <div>
        <p className="px-1 pb-2 text-[13px] font-medium text-paper/60">{t("market.report")}</p>
        {reported ? (
          <p className="px-1 text-sm text-paper/70">{t("market.reported")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {REASONS.map(({ reason, label }) => (
              <button
                key={reason}
                type="button"
                onClick={() => void report(reason)}
                className={quietBlockButton}
              >
                {t(label)}
              </button>
            ))}
          </div>
        )}
      </div>
      <RatingControl item={item} onRated={onRated} />
      <CommentsSection recipeId={item.id} onManageBlocked={onManageBlocked} />
    </div>
  );
}

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Sends one of the user's own recipes to the marketplace. Only their own are offered. */
function SubmitView() {
  const sites = useApp((s) => s.sites);
  const own = sites.filter((site) => site.origin === "user" || site.origin === "ai");
  const t = useT();
  const [recipeId, setRecipeId] = useState(own[0]?.recipeId ?? "");
  const [slug, setSlug] = useState(slugOf(own[0]?.name ?? ""));
  const [summary, setSummary] = useState("");
  const [author, setAuthor] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (own.length === 0) {
    return <p className="px-1 text-sm text-paper/55">{t("share.none")}</p>;
  }

  const pick = (id: string) => {
    setRecipeId(id);
    setSlug(slugOf(own.find((site) => site.recipeId === id)?.name ?? ""));
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await marketplace.submit(recipeId, slug, summary, author);
      setSent(true);
    } catch (failure) {
      setError(appError(failure));
    } finally {
      setBusy(false);
    }
  };

  if (sent) return <p className="px-1 text-sm text-paper/70">{t("market.share.sent")}</p>;

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-[13px] leading-snug text-paper/50">{t("market.share.note")}</p>
      <label className="flex flex-col gap-1.5 text-sm text-paper/70">
        {t("market.share.recipe")}
        <select value={recipeId} onChange={(event) => pick(event.target.value)} className={field}>
          {own.map((site) => (
            <option key={site.recipeId} value={site.recipeId}>
              {site.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-paper/70">
        {t("market.share.name")}
        <input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          maxLength={61}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-paper/70">
        {t("market.share.summary")}
        <input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          maxLength={140}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-paper/70">
        {t("market.share.author")}
        <input
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
          maxLength={60}
          className={field}
        />
      </label>
      {error && <p className="px-1 text-sm text-paper/70">{error}</p>}
      <button
        type="button"
        disabled={busy || !slug || !summary.trim() || !author.trim()}
        onClick={() => void send()}
        className={`self-start ${primaryButton}`}
      >
        {t("market.share.send")}
      </button>
    </div>
  );
}
