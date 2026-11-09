import { useEffect, useRef, useState } from "react";
import { library, siteView, type SiteViewState } from "../../shared/ipc";
import { appError, selectPage, useApp } from "../../app/store";
import { pageShowing } from "../../app/splash";
import { useT } from "../../i18n/useT";
import { railsFor, useDockReserve } from "./desktopLayout";
import { usePageMargin } from "./usePageMargin";
import { readRect, useSiteViewRect } from "./useSiteViewRect";
import { observeTitle, quickFavoriteOf, type Watch } from "./unreadWatch";
import { usableQuickAccess } from "../../shared/favorites";
import { useEntitlementStore } from "../paywall/store";

/** How often idle and surplus hidden sessions are swept. */
const SWEEP_MS = 60_000;

/**
 * The page itself. This component only reserves the rectangle the native site view fills and
 * mirrors page state into the store; the web content is drawn by native code underneath. Each
 * session is its own native view; this layer opens, shows and sweeps them.
 */
export function WebLayer() {
  const slot = useRef<HTMLDivElement>(null);
  const profileId = useApp((s) => s.state?.profileId);
  const action = useApp((s) => s.action);
  const hasSession = useApp((s) => s.activeId !== null);
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
  const desktop = useApp((s) => s.desktop);
  const fabEdge = useApp((s) => s.fabEdge);
  const backButton = useApp((s) => s.state?.backButton ?? false);
  const rails = railsFor(desktop, fabEdge, backButton);
  const docks = useDockReserve(desktop);
  const pageBottom = Math.max(bottomMargin, docks.bottom);

  useSiteViewRect(slot);

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
    const watches = new Map<string, Watch>();
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
      const favorite = quickFavoriteOf(sessions, favorites, page.session);
      if (favorite) {
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
        const visible = useApp.getState().activeId === page.session;
        if (visible && !page.loading && page.url && page.url !== lastSaved) {
          lastSaved = page.url;
          void library.setLastUrl(page.url).catch(() => {});
        }
      }),
      siteView.onClosed((session) => {
        watches.delete(session);
        forgetSessions([session]);
      }),
      siteView.onMemoryWarning(() => trimSessions("memory")),
      siteView.onError(reportError),
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
      {!hasSession && (
        <div className="fixed inset-0 grid place-items-center bg-ink p-10 text-center text-paper/60">
          <p className="max-w-60 text-sm leading-relaxed">{t("web.emptyHint")}</p>
        </div>
      )}
      <div
        ref={slot}
        className="pointer-events-none fixed"
        style={{
          left: rails.left,
          right: rails.right,
          top: `calc(var(--safe-top) + ${docks.top}px)`,
          bottom: pageBottom,
        }}
      >
        {opening && (
          <div role="status" className="absolute inset-0 grid place-items-center">
            <span
              aria-hidden="true"
              className="size-7 rounded-full border-2 border-paper/15 border-t-accent motion-safe:animate-spin"
            />
            <span className="sr-only">{t("web.loading")}</span>
          </div>
        )}
      </div>
      <div
        aria-hidden="true"
        style={{ height: pageBottom }}
        className="fixed inset-x-0 bottom-0 bg-ink"
      />
      <div className="fixed inset-x-0 top-0 h-[var(--safe-top)] bg-ink" />
    </>
  );
}
