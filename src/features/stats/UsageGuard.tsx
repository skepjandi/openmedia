import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appError, selectLocale, selectPage, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { primaryButton, quietButton } from "../settings/ui";
import { formatDuration, sectionLabel } from "./format";
import { limitStatus, secondsUntilMidnight } from "./limits";
import {
  closesSite,
  pageLock,
  policyForHost,
  policyForSection,
  sectionUsageSeconds,
  usageSeconds,
  useUsageControl,
  type PageLock,
  type UsagePolicy,
} from "./policy";
import { formatOpening } from "./schedule";
import { usageTargetOf } from "./section";
import { nameForHost, SiteBadge, useFavorites } from "./SiteBadge";
import { UsageMeter } from "./UsageMeter";
import { useEntitlementStore } from "../paywall/store";
import { openLimits } from "./view";

function rememberWarning(
  day: string,
  host: string,
  section: string | null,
  threshold: number,
): boolean {
  const key = `${host}:${section ?? ""}:${threshold}`;
  try {
    const saved: { day: string; keys: string[] } = JSON.parse(
      localStorage.getItem("om.usage.warnings") ?? "null",
    ) ?? { day, keys: [] };
    const keys = saved.day === day && Array.isArray(saved.keys) ? saved.keys : [];
    if (keys.includes(key)) return false;
    localStorage.setItem("om.usage.warnings", JSON.stringify({ day, keys: [...keys, key] }));
  } catch {
    // The in-memory set below still prevents repeated notices if storage is unavailable.
  }
  return true;
}

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearTimeout(timer);
  }, [intervalMs]);
  return now;
}

interface NoticeProps {
  host: string;
  /** The part of the site the notice is about; `null` for the site itself. */
  section: string | null;
  spent: number;
  policy: UsagePolicy | undefined;
  /** Whether the part is over its limit, so its time stops counting. */
  reached: boolean;
}

/** The heads-up shown over the page: how long today, how long is left, and a way to adjust it. */
function TimeCheck({ host, section, spent, policy, reached }: NoticeProps) {
  const t = useT();
  const favorites = useFavorites();
  const status = limitStatus(policy, spent);
  const name = nameForHost(host, favorites);
  const part = section === null ? null : sectionLabel(section, t);
  return (
    <div
      data-hit=""
      role="status"
      className="usage-warning glass fixed inset-x-3 top-[calc(var(--safe-top)+12px)] z-30 rounded-2xl p-4"
    >
      <div className="flex items-center gap-3">
        <SiteBadge host={host} name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold">
            {part === null
              ? t("usage.timeCheck", { host: name })
              : t("usage.partTimeCheck", { part, host: name })}
          </p>
          <p className="text-sm text-paper/70 tabular-nums">
            {reached
              ? t("usage.partLimitReached", { part: part ?? name, host: name })
              : status.untilLimit === null
                ? t("usage.todayValue", { value: formatDuration(Math.floor(spent), t) })
                : t("usage.pausesIn", {
                    value: formatDuration(Math.floor(spent), t),
                    left: formatDuration(status.untilLimit, t),
                  })}
          </p>
        </div>
      </div>
      {status.untilLimit !== null && (
        <div className="mt-3">
          <UsageMeter spentSeconds={spent} policy={policy} />
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => openLimits(host, section ?? undefined)}
          className={primaryButton}
        >
          {t("usage.adjust")}
        </button>
        <button
          type="button"
          onClick={() => useUsageControl.setState({ warning: null })}
          className={quietButton}
        >
          {t("usage.dismiss")}
        </button>
      </div>
    </div>
  );
}

const BROWSE_MINUTE_MS = 60_000;

/** Covers the closed page, and only the page, and says when it opens again. */
function LimitReached({
  host,
  lock,
  part,
  onBrowse,
}: {
  host: string;
  lock: PageLock;
  part: string | null;
  onBrowse: () => void;
}) {
  const t = useT();
  const favorites = useFavorites();
  const openSheet = useApp((state) => state.openSheet);
  const now = useNow(30_000);
  const locale = useApp(selectLocale);
  const site = nameForHost(host, favorites);
  const name = lock.kind === "part" && part ? `${part} · ${site}` : site;
  const scheduled = lock.kind === "schedule";
  return (
    <div
      data-hit=""
      className="absolute inset-0 z-10 grid place-items-center bg-ink/45 p-8 backdrop-blur-xl pointer-events-auto"
    >
      <section
        aria-label={t("usage.limitReachedLabel")}
        role="status"
        className="w-full max-w-sm rounded-3xl border border-hair bg-ink/90 p-6 text-center"
      >
        <div className="flex justify-center">
          <SiteBadge host={host} name={site} />
        </div>
        <h1 className="mt-4 text-xl font-semibold">
          {scheduled ? t("usage.scheduleClosed") : t("usage.limitReached")}
        </h1>
        <p className="mt-2 break-words text-sm leading-relaxed text-paper/70">
          {lock.kind === "schedule"
            ? lock.opensAt === null
              ? t("usage.scheduleNoticeAlways", { name })
              : t("usage.scheduleNotice", {
                  name,
                  time: formatOpening(lock.opensAt, now, locale),
                })
            : t("usage.pausedNotice", {
                name,
                value: formatDuration(Math.floor(lock.spent), t),
                left: formatDuration(secondsUntilMidnight(now), t),
              })}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          {lock.kind === "part" && (
            <button type="button" onClick={onBrowse} className={`${primaryButton} py-3`}>
              {t("usage.browseOther")}
            </button>
          )}
          <button
            type="button"
            onClick={() => openLimits(host)}
            className={`${lock.kind === "part" ? quietButton : primaryButton} py-3`}
          >
            {scheduled ? t("usage.adjustSchedule") : t("usage.adjust")}
          </button>
          <button
            type="button"
            onClick={() => openSheet("stats")}
            className={`${quietButton} py-3`}
          >
            {t("usage.seeUsage")}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Whether a limit has closed the page in front, and the figures that decided it. */
export function useLimitBlock() {
  const control = useUsageControl();
  const now = useNow(15_000);
  const page = useApp(selectPage);
  const isPro = useEntitlementStore((state) => state.status === "pro");
  const target = page ? usageTargetOf(page.url ?? page.openedUrl, page.scope) : null;
  const host = target?.host;
  const seconds = host ? usageSeconds(control.seconds, host) : 0;
  const policy = host ? policyForHost(control.limits.sites, host) : undefined;
  const lock =
    isPro && control.ready && target
      ? pageLock(control.limits, control.seconds, control.sectionSeconds, target, now)
      : null;
  return { control, isPro, host, target, seconds, policy, lock, now, blocked: closesSite(lock) };
}

/**
 * Rendered inside the page's own rectangle, so the hub bar, the fan and every other control stay
 * usable while a site or a part of it is closed.
 */
export function LimitCover() {
  const { host, target, lock } = useLimitBlock();
  const sheet = useApp((state) => state.sheet);
  const t = useT();
  // A closed part is not frozen (the site's own navigation is the way out of it), so the cover can
  // be set aside while the user looks for a way out. It returns a minute later if the page is still
  // in the closed part, and when the part is entered again.
  const [browsing, setBrowsing] = useState<string | null>(null);
  const key = lock?.kind === "part" && target ? `${target.host}${target.section}` : null;
  if (key === null && browsing !== null) setBrowsing(null);
  // Staying in the closed part brings the cover back after a minute.
  useEffect(() => {
    if (browsing === null) return;
    const timer = window.setTimeout(() => setBrowsing(null), BROWSE_MINUTE_MS);
    return () => window.clearTimeout(timer);
  }, [browsing]);
  if (!lock || !host || sheet !== "none" || (key !== null && browsing === key)) return null;
  return (
    <LimitReached
      host={host}
      lock={lock}
      part={lock.kind === "part" && target ? sectionLabel(target.section, t) : null}
      onBrowse={() => setBrowsing(key)}
    />
  );
}

export function UsageGuard() {
  const { control, isPro, seconds, policy, target, blocked, now } = useLimitBlock();
  const sessions = useApp((state) => state.sessions);
  const sheet = useApp((state) => state.sheet);
  const onboarding = useApp((state) => state.onboardingOpen);
  const reportError = useApp((state) => state.reportError);
  const requested = useRef(new Map<string, boolean>());
  const queues = useRef(new Map<string, Promise<unknown>>());
  const warned = useRef(new Set<string>());

  const partPolicy = target
    ? policyForSection(control.limits.sections, target.host, target.section)
    : undefined;
  const partSpent = target
    ? sectionUsageSeconds(control.sectionSeconds, target.host, target.section)
    : 0;

  useEffect(() => {
    if (!control.ready) return;
    const live = new Set(sessions.map((session) => session.id));
    for (const id of requested.current.keys()) {
      if (!live.has(id)) {
        requested.current.delete(id);
        queues.current.delete(id);
      }
    }
    for (const session of sessions) {
      const sessionTarget = usageTargetOf(session.url ?? session.openedUrl, session.scope);
      const shouldBlock =
        isPro &&
        !!sessionTarget &&
        closesSite(
          pageLock(control.limits, control.seconds, control.sectionSeconds, sessionTarget, now),
        );
      const previous = requested.current.get(session.id);
      if (previous === shouldBlock || (previous === undefined && !shouldBlock)) continue;
      requested.current.set(session.id, shouldBlock);
      const queued = (queues.current.get(session.id) ?? Promise.resolve())
        .then(() => invoke("set_usage_blocked", { session: session.id, blocked: shouldBlock }))
        .catch((error: unknown) => {
          if (requested.current.get(session.id) === shouldBlock)
            requested.current.delete(session.id);
          reportError(appError(error));
        });
      queues.current.set(session.id, queued);
    }
  }, [control, sessions, reportError, isPro, now]);

  useEffect(() => {
    if (!control.ready || !target) return;
    if (!isPro || sheet !== "none" || onboarding || document.visibilityState !== "visible") return;
    const part = partPolicy;
    const site = policy;
    // The part's own limit comes first: it is the tighter of the two.
    const notice =
      part?.limitSeconds != null && partSpent >= part.limitSeconds
        ? {
            section: target.section,
            threshold: part.limitSeconds,
            reached: true,
            spent: partSpent,
          }
        : part?.warnSeconds != null && partSpent >= part.warnSeconds
          ? {
              section: target.section,
              threshold: part.warnSeconds,
              reached: false,
              spent: partSpent,
            }
          : site?.warnSeconds != null && seconds >= site.warnSeconds
            ? { section: null, threshold: site.warnSeconds, reached: false, spent: seconds }
            : null;
    if (!notice) return;
    const key = `${control.day}:${target.host}:${notice.section ?? ""}:${notice.threshold}`;
    if (warned.current.has(key)) return;
    warned.current.add(key);
    if (rememberWarning(control.day, target.host, notice.section, notice.threshold)) {
      useUsageControl.setState({
        warning: {
          host: target.host,
          section: notice.section,
          seconds: notice.spent,
          reached: notice.reached,
        },
      });
    }
  }, [
    isPro,
    control.ready,
    control.day,
    control.limits,
    control.sectionSeconds,
    target,
    partPolicy,
    policy,
    partSpent,
    seconds,
    blocked,
    sheet,
    onboarding,
  ]);

  useEffect(() => {
    if (!control.warning) return;
    const timer = window.setTimeout(() => useUsageControl.setState({ warning: null }), 8_000);
    return () => window.clearTimeout(timer);
  }, [control.warning]);

  const warning = control.warning;
  return (
    <>
      {warning && !blocked && sheet === "none" && (
        <TimeCheck
          host={warning.host}
          section={warning.section}
          spent={warning.seconds}
          policy={
            warning.section === null
              ? policyForHost(control.limits.sites, warning.host)
              : policyForSection(control.limits.sections, warning.host, warning.section)
          }
          reached={warning.reached}
        />
      )}
    </>
  );
}
