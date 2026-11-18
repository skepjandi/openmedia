import { useEffect, useState } from "react";
import { selectLocale, selectQuickFavorites, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { QUICK_ACCESS_LIMIT, displayHost, quickAccess } from "../../shared/favorites";
import { usage, type Favorite, type UsageReport } from "../../shared/ipc";
import { PlusIcon, ReloadIcon } from "../../shared/icons";
import { Screen } from "../../shared/Screen";
import { useIconForUrl } from "../../shared/siteIcons";
import { SiteTile } from "../../shared/SiteTile";
import { describeAddress } from "../history/address";
import { formatDuration, localDay } from "../stats/format";
import { Group, GroupLabel, primaryBlockButton, quietButton } from "../settings/ui";
import { findFavoriteSession, type Session } from "../web/sessions";
import { FavoriteRows } from "./FavoriteRows";
import { formatMs, orderedTabs, secondsTodayFor } from "./tabs";

const NO_HISTORY: string[] = [];
/** How many recent addresses the Tabs screen shows; the History screen has them all. */
const HISTORY_PREVIEW = 8;

/** Every open site, the quick-access sites and recent history in one place, with how each open site performs. */
export function TabsSheet() {
  const open = useApp((s) => s.sheet === "tabs");
  const closeSheet = useApp((s) => s.closeSheet);
  const openSheet = useApp((s) => s.openSheet);
  const sessions = useApp((s) => s.sessions);
  const activeId = useApp((s) => s.activeId);
  const blankTab = useApp((s) => s.blankTab);
  const openNewTab = useApp((s) => s.openNewTab);
  const favorites = useApp(selectQuickFavorites);
  const history = useApp((s) => s.state?.history) ?? NO_HISTORY;
  const openSession = useApp((s) => s.openSession);
  const openHistory = useApp((s) => s.openHistory);
  const closeSession = useApp((s) => s.closeSession);
  const resetSession = useApp((s) => s.resetSession);
  const closeOtherSessions = useApp((s) => s.closeOtherSessions);
  const t = useT();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    usage
      .report(localDay(new Date()), 1)
      .then((next) => {
        if (cancelled) return;
        setReport(next);
        setNow(Date.now());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const tabs = orderedTabs(sessions, activeId);

  return (
    <Screen
      title={t("tabs.title")}
      subtitle={t("tabs.subtitle")}
      closeLabel={t("tabs.close")}
      onClose={closeSheet}
    >
      <div className="flex flex-col gap-6">
        <section>
          <GroupLabel>{t("tabs.open")}</GroupLabel>
          <button type="button" onClick={openNewTab} className={`mb-3 ${primaryBlockButton}`}>
            <PlusIcon />
            {t("tabs.newTab")}
          </button>
          {tabs.length === 0 ? (
            <Empty text={t("tabs.openEmpty")} />
          ) : (
            <Group>
              {tabs.map((session) => (
                <OpenTab
                  key={session.id}
                  session={session}
                  active={session.id === activeId && !blankTab}
                  now={now}
                  secondsToday={secondsTodayFor(report, session.scope)}
                  favorites={favorites}
                  onOpen={() => openSession(session.id)}
                  onClose={() => closeSession(session.id)}
                  onReset={() => resetSession(session.id)}
                />
              ))}
            </Group>
          )}
          {tabs.length > 1 && (
            <button type="button" onClick={closeOtherSessions} className={`mt-3 ${quietButton}`}>
              {t("tabs.closeOthers")}
            </button>
          )}
          <p className="px-1 pt-2 text-[13px] leading-snug text-paper/50">{t("tabs.closeNote")}</p>
        </section>

        <section>
          <GroupLabel>{t("tabs.quickAccess")}</GroupLabel>
          {favorites.length === 0 ? (
            <Empty text={t("favorites.quickEmpty")} />
          ) : (
            <FavoriteRows
              favorites={favorites}
              shown={quickAccess(favorites).map((_, index) => index)}
            />
          )}
          {favorites.length > QUICK_ACCESS_LIMIT && (
            <button
              type="button"
              onClick={() => openSheet("favorites")}
              className={`mt-3 ${quietButton}`}
            >
              {t("favorites.more", { count: favorites.length - QUICK_ACCESS_LIMIT })}
            </button>
          )}
        </section>

        <section>
          <GroupLabel>{t("tabs.history")}</GroupLabel>
          {history.length === 0 ? (
            <Empty text={t("history.empty")} />
          ) : (
            <>
              <Group>
                {history.slice(0, HISTORY_PREVIEW).map((url) => (
                  <HistoryRow
                    key={url}
                    url={url}
                    favorites={favorites}
                    sessions={sessions}
                    onOpen={() => openHistory(url)}
                  />
                ))}
              </Group>
              {history.length > HISTORY_PREVIEW && (
                <button
                  type="button"
                  onClick={() => openSheet("history")}
                  className={`mt-3 ${quietButton}`}
                >
                  {t("tabs.allHistory", { count: history.length })}
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </Screen>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-2xl border border-dashed border-hair px-4 py-5 text-sm text-paper/55">
      {text}
    </p>
  );
}

interface OpenTabProps {
  session: Session;
  active: boolean;
  now: number;
  secondsToday: number | null;
  favorites: readonly Favorite[];
  onOpen: () => void;
  onClose: () => void;
  onReset: () => void;
}

function OpenTab({
  session,
  active,
  now,
  secondsToday,
  favorites,
  onOpen,
  onClose,
  onReset,
}: OpenTabProps) {
  const t = useT();
  const locale = useApp(selectLocale);
  const address = session.url ?? session.openedUrl;
  const host = displayHost(address);
  const icon = useIconForUrl(address, favorites);
  const title = session.title?.trim() || host;
  const idleMs = now - session.lastUsed;
  const stats = [
    session.paintMs !== null ? t("tabs.statPaint", { value: formatMs(session.paintMs) }) : null,
    session.loadMs !== null ? t("tabs.statLoad", { value: formatMs(session.loadMs) }) : null,
    secondsToday !== null ? t("tabs.statToday", { value: formatDuration(secondsToday, t) }) : null,
    active ? t("tabs.statShowing") : t("tabs.statIdle", { value: relativeAge(idleMs, locale) }),
  ].filter((part): part is string => part !== null);

  return (
    <div className="flex items-center">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-start active:bg-paper/[0.06]"
      >
        <SiteTile name={host} icon={icon} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium">{title}</span>
          <span className="block truncate text-sm text-paper/55">{host}</span>
          <span className="mt-0.5 block text-[13px] leading-snug text-paper/50 tabular-nums">
            {session.loading ? t("tabs.loading") : stats.join(" · ")}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={t("tabs.resetOne", { name: title })}
        onClick={onReset}
        className="grid size-12 shrink-0 place-items-center text-paper/55 active:bg-paper/[0.06]"
      >
        <ReloadIcon />
      </button>
      <button
        type="button"
        aria-label={t("tabs.closeOne", { name: title })}
        onClick={onClose}
        className="grid size-12 shrink-0 place-items-center text-paper/55 active:bg-paper/[0.06]"
      >
        <TabsCloseIcon />
      </button>
    </div>
  );
}

function HistoryRow({
  url,
  favorites,
  sessions,
  onOpen,
}: {
  url: string;
  favorites: readonly Favorite[];
  sessions: Session[];
  onOpen: () => void;
}) {
  const t = useT();
  const { host, rest } = describeAddress(url);
  const icon = useIconForUrl(url, favorites);
  const live = findFavoriteSession(sessions, url) !== undefined;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-start active:bg-paper/[0.06]"
    >
      <SiteTile name={host} icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium">{host}</span>
        {rest && <span className="block truncate text-sm text-paper/50 tabular-nums">{rest}</span>}
      </span>
      {live && <span className="shrink-0 text-sm text-accent">{t("tabs.isOpen")}</span>}
    </button>
  );
}

function TabsCloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** `3 minutes ago` in the app's language. */
function relativeAge(ms: number, locale: string): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return formatter.format(0, "minute");
  if (minutes < 60) return formatter.format(-minutes, "minute");
  return formatter.format(-Math.round(minutes / 60), "hour");
}
