import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appError, selectPage, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { primaryButton, quietButton } from "../settings/ui";
import { formatDuration } from "./format";
import { limitStatus, secondsUntilMidnight } from "./limits";
import { limitReached, policyForHost, usageSeconds, useUsageControl } from "./policy";
import { usageTargetOf } from "./section";
import { nameForHost, SiteBadge, useFavorites } from "./SiteBadge";
import { UsageMeter } from "./UsageMeter";
import { useEntitlementStore } from "../paywall/store";
import { openLimits } from "./view";

function rememberWarning(day: string, host: string, threshold: number): boolean {
  const key = `${host}:${threshold}`;
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
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The heads-up shown over the page: how long today, how long is left, and a way to adjust it. */
function TimeCheck({ host }: { host: string }) {
  const t = useT();
  const favorites = useFavorites();
  const policies = useUsageControl((s) => s.policies);
  const totals = useUsageControl((s) => s.seconds);
  const policy = policyForHost(policies, host);
  const spent = usageSeconds(totals, host);
  const status = limitStatus(policy, spent);
  const name = nameForHost(host, favorites);
  return (
    <div
      data-hit=""
      role="status"
      className="usage-warning glass fixed inset-x-3 top-[calc(var(--safe-top)+12px)] z-30 rounded-2xl p-4"
    >
      <div className="flex items-center gap-3">
        <SiteBadge host={host} name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold">{t("usage.timeCheck", { host: name })}</p>
          <p className="text-sm text-paper/70 tabular-nums">
            {status.untilLimit === null
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
        <button type="button" onClick={() => openLimits(host)} className={primaryButton}>
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

/** Covers the paused site's page and says when it opens again. */
function LimitReached({ host, seconds }: { host: string; seconds: number }) {
  const t = useT();
  const favorites = useFavorites();
  const openSheet = useApp((state) => state.openSheet);
  const now = useNow(30_000);
  const name = nameForHost(host, favorites);
  return (
    <div
      data-hit=""
      className="fixed inset-0 z-10 grid place-items-center bg-ink/45 p-8 backdrop-blur-xl"
    >
      <section
        aria-label={t("usage.limitReachedLabel")}
        role="status"
        className="w-full max-w-sm rounded-3xl border border-hair bg-ink/90 p-6 text-center"
      >
        <div className="flex justify-center">
          <SiteBadge host={host} name={name} />
        </div>
        <h1 className="mt-4 text-xl font-semibold">{t("usage.limitReached")}</h1>
        <p className="mt-2 break-words text-sm leading-relaxed text-paper/70">
          {t("usage.pausedNotice", {
            name,
            value: formatDuration(Math.floor(seconds), t),
            left: formatDuration(secondsUntilMidnight(now), t),
          })}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => openLimits(host)}
            className={`${primaryButton} py-3`}
          >
            {t("usage.adjust")}
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

/** Whether today's limit has closed the page in front, and the figures that decided it. */
export function useLimitBlock() {
  const control = useUsageControl();
  const page = useApp(selectPage);
  const isPro = useEntitlementStore((state) => state.status === "pro");
  const host = page ? usageTargetOf(page.url ?? page.openedUrl, page.scope)?.host : undefined;
  const seconds = host ? usageSeconds(control.seconds, host) : 0;
  const policy = host ? policyForHost(control.policies, host) : undefined;
  const blocked = isPro && control.ready && limitReached(policy, seconds);
  return { control, isPro, host, seconds, policy, blocked };
}

export function UsageGuard() {
  const { control, isPro, host, seconds, policy, blocked } = useLimitBlock();
  const sessions = useApp((state) => state.sessions);
  const sheet = useApp((state) => state.sheet);
  const onboarding = useApp((state) => state.onboardingOpen);
  const reportError = useApp((state) => state.reportError);
  const requested = useRef(new Map<string, boolean>());
  const queues = useRef(new Map<string, Promise<unknown>>());
  const warned = useRef(new Set<string>());

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
      const target = usageTargetOf(session.url ?? session.openedUrl, session.scope);
      const shouldBlock =
        isPro &&
        !!target &&
        limitReached(
          policyForHost(control.policies, target.host),
          usageSeconds(control.seconds, target.host),
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
  }, [control, sessions, reportError, isPro]);

  useEffect(() => {
    const threshold = policy?.warnSeconds;
    if (!isPro || sheet !== "none" || onboarding || document.visibilityState !== "visible") return;
    if (!control.ready || !host || threshold == null || seconds < threshold || blocked) return;
    const key = `${control.day}:${host}:${threshold}`;
    if (warned.current.has(key)) return;
    warned.current.add(key);
    if (rememberWarning(control.day, host, threshold)) {
      useUsageControl.setState({ warning: { host, seconds } });
    }
  }, [
    isPro,
    control.ready,
    control.day,
    host,
    policy?.warnSeconds,
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

  return (
    <>
      {control.warning && !blocked && sheet === "none" && <TimeCheck host={control.warning.host} />}
      {blocked && sheet === "none" && host && <LimitReached host={host} seconds={seconds} />}
    </>
  );
}
