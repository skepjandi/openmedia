import { useEntitlementStore } from "../paywall/store";
import { appError, useApp, selectPage, type AppStore } from "../../app/store";
import { usage } from "../../shared/ipc";
import { advance, createAccumulator, drain, type UsageEntry } from "./accumulator";
import { localDay } from "./format";
import {
  isUsageBlocked,
  NO_LIMITS,
  policyForSection,
  sectionUsageSeconds,
  usageLimits,
  useUsageControl,
  type UsageLimits,
} from "./policy";
import { usePauseCover } from "./pause";
import { usageTargetOf, type UsageTarget } from "./section";

const TICK_MS = 1_000;
const FLUSH_SECONDS = 30;
let writes: Promise<unknown> = Promise.resolve();
let flushPending: (() => void) | undefined;

/** Includes time still in the current batch before a report is requested. */
export function settleUsageWrites(): Promise<unknown> {
  flushPending?.();
  return writes;
}

export function currentTarget(store: AppStore, visible: boolean): UsageTarget | null {
  if (!visible || store.sheet !== "none" || store.onboardingOpen) return null;
  const page = selectPage(store);
  const target = page?.url ? usageTargetOf(page.url, page.scope) : null;
  if (!target || isUsageBlocked(target.host)) return null;
  return page && usePauseCover.getState().sessionId === page.id ? null : target;
}

/**
 * The seconds that may still be counted for each entry. A part of a site that has used up its
 * own daily limit stops counting; the rest of the site keeps counting.
 */
function clampToLimits(
  entries: UsageEntry[],
  limits: UsageLimits,
  sectionSeconds: Record<string, Record<string, number>>,
): UsageEntry[] {
  const kept: UsageEntry[] = [];
  const counted = new Map<string, number>();
  for (const entry of entries) {
    const limit =
      policyForSection(limits.sections, entry.host, entry.section)?.limitSeconds ?? null;
    if (limit === null) {
      kept.push(entry);
      continue;
    }
    const key = `${entry.host} ${entry.section}`;
    const spent =
      sectionUsageSeconds(sectionSeconds, entry.host, entry.section) + (counted.get(key) ?? 0);
    const left = limit - spent;
    if (left <= 0) continue;
    const seconds = Math.min(entry.seconds, left);
    counted.set(key, (counted.get(key) ?? 0) + seconds);
    kept.push({ ...entry, seconds });
  }
  return kept;
}

export function startUsageTracking(): () => void {
  let acc = createAccumulator(Date.now());
  let day = localDay(new Date());
  let pending: UsageEntry[] = [];
  let stopped = false;
  let stepping = false;
  let loading = false;
  const target = () =>
    useUsageControl.getState().ready
      ? currentTarget(useApp.getState(), document.visibilityState === "visible")
      : null;
  const fail = (error: unknown) => useApp.getState().reportError(appError(error));
  const isPro = () => useEntitlementStore.getState().status === "pro";

  const load = async () => {
    if (!isPro() || loading) return;
    loading = true;
    const requestedDay = day;
    try {
      await writes;
      const [limits, report] = await Promise.all([
        usageLimits.get(),
        usage.report(requestedDay, 1),
      ]);
      if (stopped || requestedDay !== day || !isPro()) return;
      useUsageControl.setState({
        day,
        limits,
        seconds: Object.fromEntries(report.sites.map((site) => [site.host, site.seconds])),
        sectionSeconds: Object.fromEntries(
          report.sites.map((site) => [
            site.host,
            Object.fromEntries(site.sections.map((part) => [part.section, part.seconds])),
          ]),
        ),
        ready: true,
      });
    } catch (error) {
      if (isPro()) fail(error);
    } finally {
      loading = false;
    }
  };

  const flush = () => {
    if (pending.length === 0) return;
    const entries = pending;
    const recordedDay = day;
    pending = [];
    writes = writes.then(async () => {
      for (const entry of entries) {
        await usage.record(recordedDay, entry.host, entry.section, entry.seconds).catch(fail);
      }
    });
  };

  const collect = (now: number) => {
    acc = advance(acc, now, target());
    const { entries, rest } = drain(acc);
    acc = rest;
    if (entries.length === 0) return;
    const state = useUsageControl.getState();
    const kept = clampToLimits(entries, state.limits, state.sectionSeconds);
    if (kept.length === 0) return;
    pending.push(...kept);
    const seconds = { ...state.seconds };
    const sectionSeconds = { ...state.sectionSeconds };
    for (const entry of kept) {
      seconds[entry.host] = (seconds[entry.host] ?? 0) + entry.seconds;
      const parts = { ...(sectionSeconds[entry.host] ?? {}) };
      parts[entry.section] = (parts[entry.section] ?? 0) + entry.seconds;
      sectionSeconds[entry.host] = parts;
    }
    useUsageControl.setState({ seconds, sectionSeconds });
    // Once the limit is reached, the next interval must never accrue time on that site.
    acc = { ...acc, target: target() };
  };

  const step = (flushAlways: boolean) => {
    if (stepping || stopped) return;
    stepping = true;
    const now = Date.now();
    const nextDay = localDay(new Date(now));
    if (nextDay !== day) {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const boundary = midnight.getTime();
      const crossesMidnight = boundary >= acc.lastAt && now - acc.lastAt <= 10_000;
      // Split an ordinary midnight tick between dates, without crediting a suspended night.
      if (crossesMidnight) collect(boundary);
      flush();
      day = nextDay;
      acc = createAccumulator(now);
      useUsageControl.setState({
        day,
        seconds: {},
        sectionSeconds: {},
        warning: null,
        ready: false,
      });
    }
    collect(now);
    if (flushAlways || pending.reduce((sum, entry) => sum + entry.seconds, 0) >= FLUSH_SECONDS)
      flush();
    stepping = false;
    if (isPro() && !useUsageControl.getState().ready) void load();
  };

  const onLeave = () => step(true);
  const timer = window.setInterval(() => step(false), TICK_MS);
  const unsubscribe = useApp.subscribe(onLeave);
  const unsubscribePolicies = useUsageControl.subscribe((next, previous) => {
    if (next.ready !== previous.ready || next.limits !== previous.limits) step(true);
  });
  const unsubscribeEntitlement = useEntitlementStore.subscribe((next, previous) => {
    if (next.status === previous.status) return;
    if (next.status === "pro") {
      void load();
    } else {
      useUsageControl.setState({
        limits: NO_LIMITS,
        seconds: {},
        sectionSeconds: {},
        warning: null,
        ready: false,
      });
    }
  });
  flushPending = onLeave;
  document.addEventListener("visibilitychange", onLeave);
  window.addEventListener("pagehide", onLeave);
  window.addEventListener("blur", onLeave);
  window.addEventListener("focus", onLeave);
  if (isPro()) void load();

  return () => {
    step(true);
    stopped = true;
    flushPending = undefined;
    window.clearInterval(timer);
    unsubscribe();
    unsubscribeEntitlement();
    unsubscribePolicies();
    document.removeEventListener("visibilitychange", onLeave);
    window.removeEventListener("pagehide", onLeave);
    window.removeEventListener("blur", onLeave);
    window.removeEventListener("focus", onLeave);
  };
}
