import { useEffect, useRef, useState } from "react";
import { library, siteView, type SiteViewState } from "../../shared/ipc";
import { appError, selectPage, useApp } from "../../app/store";
import { pageShowing } from "../../app/splash";
import { useT } from "../../i18n/useT";
import { Spinner } from "../../shared/Spinner";
import { usePageMargin } from "./usePageMargin";
import { readRect, useSiteViewRect } from "./useSiteViewRect";
import { observeTitle, quickFavoriteOf, type Watch } from "./unreadWatch";
import { usableQuickAccess } from "../../shared/favorites";
import { useEntitlementStore } from "../paywall/store";
import { advanceTrail } from "./sessions";
import { leftSearchForSite } from "../history/searchVisit";
import { HubBar } from "../hubs/HubBar";
import { PauseCover } from "../stats/PauseCover";
import { LimitCover } from "../stats/UsageGuard";

/** How often idle and surplus hidden sessions are swept. */
const SWEEP_MS = 60_000;

/** The least time between two warnings that a pop-up was dropped. */
const POPUP_WARNING_GAP_MS = 30_000;

/**
 * The page itself. This component only reserves the rectangle the native site view fills and
 * mirrors page state into the store; the web content is drawn by native code underneath. Each
 * session is its own native view; this layer opens, shows and sweeps them.
 */
export function WebLayer() {
  const slot = useRef<HTMLDivElement>(null);
  const profileId = useApp((s) => s.state?.profileId);
  const action = useApp((s) => s.action);
  const showEmpty = useApp((s) => s.activeId === null || s.blankTab);
  const opening = useApp((s) => s.error === null && !pageShowing(selectPage(s)));
  const setSessionState = useApp((s) => s.setSessionState);
  const sessionOpenFailed = useApp((s) => s.sessionOpenFailed);
  const forgetSessions = useApp((s) => s.forgetSessions);
  const openSession = useApp((s) => s.openSession);
  const trimSessions = useApp((s) => s.trimSessions);
  const reportError = useApp((s) => s.reportError);
  const t = useT();
  const translate = useRef(t);
  useEffect(() => {
    translate.current = t;
  }, [t]);
  /** Native events are only announced once, so no action may run before the listeners exist. */
  const [listening, setListening] = useState(false);

  const bottomMargin = usePageMargin();

  useSiteViewRect(slot);

  // A blank page over the one in front leaves it alive underneath: tell the native side, so what it
  // plays is handled as that of a page left for another.
  useEffect(() => {
    siteView.setCovered(showEmpty).catch(() => {});
  }, [showEmpty]);

  useEffect(() => {
    const element = slot.current;
    if (!listening || !profileId || !action || !element) return;
    const run =
      action.type === "activate"
        ? siteView.activate(action.id)
        : action.type === "adopt"
          ? library.adoptBootSession(action.id, action.url, readRect(element))
          : library.openSite(action.id, action.url, readRect(element));
    run.catch((error: unknown) => {
      if (action.type !== "activate") sessionOpenFailed(action.id);
      reportError(appError(error));
    });
  }, [listening, profileId, action, sessionOpenFailed, reportError]);

  useEffect(() => {
    let lastPopupWarning = 0;
    const watches = new Map<string, Watch>();
    /** The last address each session finished loading, to tell when it left a search for a site. */
    const loadedUrls = new Map<string, string>();
    /** The pages behind each session's page, seeded from the pages saved before a restart. */
    const trails = new Map<string, readonly string[]>();
    const raiseNotification = (page: SiteViewState) => {
      const { activeId, sessions, state } = useApp.getState();
      const observation = observeTitle(
        watches.get(page.session),
        page.title,
        activeId !== page.session,
        Date.now(),
      );
      watches.set(page.session, observation.watch);
      if (!observation.notify) return;
      const favorites = usableQuickAccess(
        state?.favorites ?? [],
        useEntitlementStore.getState().status === "pro",
      );
      const favorite = quickFavoriteOf(sessions, favorites, page.session, useApp.getState().sites);
      if (favorite?.notify) {
        void siteView
          .notify(page.session, favorite.name, translate.current("notify.newActivity"))
          .catch(() => {});
      }
    };
    let lastSaved = "";
    const unlisten = [
      siteView.onState((page) => {
        setSessionState(page);
        raiseNotification(page);
        if (!page.loading && page.url) {
          const previous = loadedUrls.get(page.session) ?? null;
          loadedUrls.set(page.session, page.url);
          const seed =
            useApp.getState().sessions.find((session) => session.id === page.session)
              ?.restoredBack ?? [];
          trails.set(
            page.session,
            advanceTrail(trails.get(page.session) ?? seed, previous, page.url),
          );
          if (leftSearchForSite(previous, page.url)) useApp.getState().recordVisit(page.url);
        }
        const visible = useApp.getState().activeId === page.session;
        const saved = `${page.url}\n${(trails.get(page.session) ?? []).join("\n")}`;
        if (visible && !page.loading && page.url && saved !== lastSaved) {
          lastSaved = saved;
          void library.setLastUrl(page.url, [...(trails.get(page.session) ?? [])]).catch(() => {});
        }
      }),
      siteView.onClosed((session) => {
        watches.delete(session);
        loadedUrls.delete(session);
        trails.delete(session);
        forgetSessions([session]);
      }),
      siteView.onMemoryWarning(() => trimSessions("memory")),
      siteView.onError(reportError),
      siteView.onPopupBlocked((host) => {
        // An ad script retries every tap: say it once in a while, not on every attempt.
        const at = Date.now();
        if (at - lastPopupWarning < POPUP_WARNING_GAP_MS) return;
        lastPopupWarning = at;
        reportError(translate.current("web.popupBlocked", { host }));
      }),
      siteView.onNotificationTap(openSession),
    ];
    const sweep = window.setInterval(() => trimSessions("routine"), SWEEP_MS);
    let cancelled = false;
    void Promise.all(unlisten).then(() => {
      if (!cancelled) setListening(true);
    });
    return () => {
      cancelled = true;
      window.clearInterval(sweep);
      void Promise.all(unlisten).then((fns) => fns.forEach((fn) => fn()));
    };
  }, [setSessionState, forgetSessions, trimSessions, openSession, reportError]);

  return (
    <>
      {showEmpty && (
        <div
          data-hit=""
          className="fixed inset-0 grid place-items-center bg-ink p-10 text-center text-paper/60"
        >
          <p className="max-w-60 text-sm leading-relaxed">{t("web.emptyHint")}</p>
        </div>
      )}
      <div
        className="pointer-events-none fixed inset-x-0 top-[var(--safe-top)] flex flex-col"
        style={{ bottom: bottomMargin }}
      >
        <HubBar />
        <div ref={slot} className="relative min-h-0 flex-1">
          {opening && (
            <div className="absolute inset-0 grid place-items-center">
              <Spinner size={28} label={<span className="sr-only">{t("web.loading")}</span>} />
            </div>
          )}
          <LimitCover />
          <PauseCover />
        </div>
      </div>
      <div
        aria-hidden="true"
        style={{ height: bottomMargin }}
        className="fixed inset-x-0 bottom-0 bg-ink"
      />
      <div className="fixed inset-x-0 top-0 h-[var(--safe-top)] bg-ink" />
    </>
  );
}
