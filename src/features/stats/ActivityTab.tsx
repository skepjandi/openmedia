import { useCallback, useEffect, useMemo, useState } from "react";
import { selectLocale, useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import { Chevron } from "../../shared/Chevron";
import { StatsIcon } from "../../shared/icons";
import { usage, type SiteUsage, type UsageReport } from "../../shared/ipc";
import { dangerButton, primaryButton, quietButton } from "../settings/ui";
import { formatDuration, localDay, sectionLabel } from "./format";
import { limitedThings, limitStatus } from "./limits";
import { policyForHost, policyForSection, sectionUsageSeconds, useUsageControl } from "./policy";
import { nameForHost, SiteBadge, useFavorites } from "./SiteBadge";
import { settleUsageWrites } from "./tracker";
import { STATUS_TEXT, statusText, UsageMeter } from "./UsageMeter";
import { openLimits, useUsageView } from "./view";

const RANGES: { days: number; label: MessageKey }[] = [
  { days: 1, label: "stats.today" },
  { days: 7, label: "stats.days7" },
  { days: 30, label: "stats.days30" },
];

/** How strongly the busiest sites are tinted, busiest first. Sites past the last are neutral. */
const SERIES_STRENGTH = [100, 70, 48, 32, 22];

/** One tone of the accent per rank, so the bar above the list and the bars in it read together. */
function seriesColor(rank: number): string {
  const strength = SERIES_STRENGTH[rank];
  return strength === undefined
    ? "color-mix(in srgb, var(--color-paper) 22%, transparent)"
    : `color-mix(in srgb, var(--color-accent) ${strength}%, transparent)`;
}

/** The total as large numerals with their units small and quiet. Works for any script's digits. */
function BigDuration({ text }: { text: string }) {
  return (
    <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5 px-1 leading-none tabular-nums">
      {text
        .split(/(\p{Nd}+)/u)
        .filter((part) => part.trim() !== "")
        .map((part, index) =>
          /\p{Nd}/u.test(part) ? (
            <span key={index} className="text-[3.5rem] font-semibold tracking-tight">
              {part}
            </span>
          ) : (
            <span key={index} className="me-1.5 text-xl font-medium text-paper/50">
              {part.trim()}
            </span>
          ),
        )}
    </p>
  );
}

/** Where the time went, as one bar cut into the busiest sites. The list below names each cut. */
function ShareBar({ sites, total }: { sites: SiteUsage[]; total: number }) {
  const top = sites.slice(0, SERIES_STRENGTH.length);
  const rest = total - top.reduce((sum, site) => sum + site.seconds, 0);
  const cut = (seconds: number, rank: number) => (
    <span
      key={rank}
      className="min-w-[3px]"
      style={{ flex: `${seconds} 1 0`, background: seriesColor(rank) }}
    />
  );
  return (
    <div aria-hidden="true" className="mt-5 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
      {top.map((site, rank) => cut(site.seconds, rank))}
      {rest > 0 && cut(rest, SERIES_STRENGTH.length)}
    </div>
  );
}

function Bar({ share, color }: { share: number; color: string }) {
  return (
    <span className="block h-1.5 flex-1 rounded-full bg-paper/10">
      <span
        className="block h-full rounded-full"
        style={{ width: `${Math.max(share, 0.03) * 100}%`, background: color }}
      />
    </span>
  );
}

interface SiteRowProps {
  site: SiteUsage;
  name: string;
  rank: number;
  total: number;
  showLimit: boolean;
  percent: (share: number) => string;
}

function SiteRow({ site, name, rank, total, showLimit, percent }: SiteRowProps) {
  const t = useT();
  const limits = useUsageControl((s) => s.limits);
  const sectionSeconds = useUsageControl((s) => s.sectionSeconds);
  const [open, setOpen] = useState(false);
  const policy = policyForHost(limits.sites, site.host);
  const status = limitStatus(policy, site.seconds);
  const meter = showLimit && status.state !== "none";
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-paper/[0.05]"
      >
        <SiteBadge host={site.host} name={name} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="truncate text-base font-medium">{name}</span>
            <span className="shrink-0 text-base font-semibold tabular-nums">
              {formatDuration(site.seconds, t)}
            </span>
          </span>
          {meter ? (
            <span className="mt-2 block">
              <UsageMeter spentSeconds={site.seconds} policy={policy} compact />
              <span className={`mt-1.5 block text-xs ${STATUS_TEXT[status.state]}`}>
                {statusText(status, t)}
              </span>
            </span>
          ) : (
            <span className="mt-2.5 flex items-center gap-3">
              <Bar share={site.seconds / total} color={seriesColor(rank)} />
              <span className="w-11 shrink-0 text-end text-xs text-paper/50 tabular-nums">
                {percent(site.seconds / total)}
              </span>
            </span>
          )}
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="border-t border-hair bg-paper/[0.03] px-4 py-2">
          <ul className="divide-y divide-hair">
            {site.sections.map((section) => {
              const partPolicy = policyForSection(limits.sections, site.host, section.section);
              const partSpent = showLimit
                ? sectionUsageSeconds(sectionSeconds, site.host, section.section)
                : 0;
              const partStatus = limitStatus(partPolicy, partSpent);
              return (
                <li key={section.section} className="py-3">
                  <span className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate text-paper/85">
                      {sectionLabel(section.section, t)}
                    </span>
                    <span className="shrink-0 text-paper/60 tabular-nums">
                      {formatDuration(section.seconds, t)}
                    </span>
                  </span>
                  <span className="mt-2 flex items-center gap-3">
                    <Bar share={section.seconds / site.seconds} color={seriesColor(0)} />
                    <span className="w-11 shrink-0 text-end text-xs text-paper/50 tabular-nums">
                      {percent(section.seconds / site.seconds)}
                    </span>
                  </span>
                  {showLimit && partStatus.state !== "none" && (
                    <>
                      <div className="mt-2">
                        <UsageMeter spentSeconds={partSpent} policy={partPolicy} compact />
                      </div>
                      <p className={`mt-1.5 text-xs ${STATUS_TEXT[partStatus.state]}`}>
                        {statusText(partStatus, t, true)}
                      </p>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => openLimits(site.host, section.section)}
                    className="mt-1.5 text-sm font-medium text-accent"
                  >
                    {partPolicy ? t("usage.partChangeLimit") : t("usage.partSetLimit")}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => openLimits(site.host)}
            className="mb-1 border-t border-hair pt-3 text-sm font-medium text-accent"
          >
            {policy ? t("stats.changeLimit") : t("stats.setLimit")}
          </button>
        </div>
      )}
    </li>
  );
}

/** Today against each site and part that has a limit, closest to its limit first; or an invitation to set one. */
function LimitsGlance() {
  const t = useT();
  const favorites = useFavorites();
  const limits = useUsageControl((s) => s.limits);
  const seconds = useUsageControl((s) => s.seconds);
  const sectionSeconds = useUsageControl((s) => s.sectionSeconds);
  const setTab = useUsageView((s) => s.setTab);
  const entries = limitedThings(limits, seconds, sectionSeconds);

  if (entries.length === 0) {
    return (
      <section className="mt-6 rounded-2xl border border-hair bg-paper/[0.04] p-4">
        <h2 className="text-base font-semibold">{t("stats.glanceEmptyTitle")}</h2>
        <p className="mt-1 text-sm leading-snug text-paper/60">{t("stats.glanceEmptyBody")}</p>
        <button type="button" onClick={() => setTab("limits")} className={`${primaryButton} mt-3`}>
          {t("stats.glanceEmptyAction")}
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label={t("stats.glanceTitle")}
      className="mt-6 rounded-2xl border border-hair bg-paper/[0.04] p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="eyebrow">{t("stats.glanceTitle")}</h2>
        <button
          type="button"
          onClick={() => setTab("limits")}
          className="text-sm font-medium text-accent"
        >
          {t("common.edit")}
        </button>
      </div>
      <ul className="mt-4 flex flex-col gap-5">
        {entries.slice(0, 4).map(({ host, section, policy, spent, status }) => (
          <li key={`${host}${section ?? ""}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-base font-medium">
                {nameForHost(host, favorites)}
                {section === null ? "" : ` · ${sectionLabel(section, t)}`}
              </span>
              <span className="shrink-0 text-base font-semibold tabular-nums">
                {formatDuration(Math.floor(spent), t)}
              </span>
            </div>
            <div className="mt-2">
              <UsageMeter spentSeconds={spent} policy={policy} compact />
            </div>
            <p className={`mt-1.5 text-xs ${STATUS_TEXT[status.state]}`}>
              {statusText(status, t, section !== null)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ClearStats({ onCleared }: { onCleared: () => void }) {
  const reportError = useApp((s) => s.reportError);
  const t = useT();
  const [confirming, setConfirming] = useState(false);

  const clear = () => {
    setConfirming(false);
    usage
      .clear()
      .then(() => {
        useUsageControl.setState({ seconds: {}, warning: null });
        onCleared();
      })
      .catch((error: unknown) => reportError(describeError(error, t)));
  };

  return confirming ? (
    <div className="flex gap-3">
      <button type="button" onClick={clear} className={dangerButton}>
        {t("stats.clearAll")}
      </button>
      <button type="button" onClick={() => setConfirming(false)} className={quietButton}>
        {t("common.cancel")}
      </button>
    </div>
  ) : (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="min-h-11 text-sm font-medium text-danger"
    >
      {t("stats.clear")}
    </button>
  );
}

interface ActivityTabProps {
  days: number;
  onDays: (days: number) => void;
}

/** Time spent on each site and in each part of it, for today, a week or a month. */
export function ActivityTab({ days, onDays }: ActivityTabProps) {
  const favorites = useFavorites();
  const reportError = useApp((s) => s.reportError);
  const locale = useApp(selectLocale);
  const t = useT();
  const [report, setReport] = useState<UsageReport | null>(null);

  const load = useCallback(
    () =>
      settleUsageWrites()
        .then(() => usage.report(localDay(new Date()), days))
        .then(setReport)
        .catch((error: unknown) => reportError(describeError(error, t))),
    [days, reportError, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const percent = useMemo(() => {
    const format = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
    return (share: number) => format.format(share);
  }, [locale]);

  const nameOf = (site: SiteUsage) => site.name ?? nameForHost(site.host, favorites);
  const total = report?.totalSeconds ?? 0;

  return (
    <div>
      <div
        role="group"
        aria-label={t("stats.rangeLabel")}
        className="grid grid-cols-3 gap-1 rounded-xl bg-paper/[0.07] p-1"
      >
        {RANGES.map((range) => (
          <button
            key={range.days}
            type="button"
            aria-pressed={days === range.days}
            onClick={() => onDays(range.days)}
            className={`rounded-lg py-2 text-sm font-medium ${
              days === range.days ? "bg-accent text-on-accent" : "text-paper/70"
            }`}
          >
            {t(range.label)}
          </button>
        ))}
      </div>

      <p className="eyebrow mt-8 px-1">{t("stats.timeOnSites")}</p>
      <BigDuration text={formatDuration(total, t)} />
      {days > 1 && total > 0 && (
        <p className="mt-3 px-1 text-sm text-paper/55">
          {t("stats.averagePerDay", { value: formatDuration(Math.round(total / days), t) })}
        </p>
      )}
      {report && total > 0 && <ShareBar sites={report.sites} total={total} />}

      <LimitsGlance />

      {report && report.sites.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-8 pt-12 text-center">
          <span className="grid size-14 place-items-center rounded-full bg-paper/[0.06] text-paper/50">
            <StatsIcon />
          </span>
          <p className="max-w-xs text-sm leading-relaxed text-paper/55">{t("stats.empty")}</p>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-hair overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
          {report?.sites.map((site, rank) => (
            <SiteRow
              key={site.host}
              site={site}
              name={nameOf(site)}
              rank={rank}
              total={total}
              showLimit={days === 1}
              percent={percent}
            />
          ))}
        </ul>
      )}

      <footer className="mt-10 flex flex-col items-start gap-2 px-1">
        <h2 className="eyebrow">{t("stats.privateTitle")}</h2>
        <p className="text-[13px] leading-relaxed text-paper/50">{t("stats.privateBody")}</p>
        <ClearStats onCleared={() => void load()} />
      </footer>
    </div>
  );
}
