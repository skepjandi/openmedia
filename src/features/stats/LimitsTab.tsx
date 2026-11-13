import { useEffect, useMemo, useRef, useState, type SubmitEvent } from "react";
import { useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import type { Translate } from "../../i18n/translate";
import { useT } from "../../i18n/useT";
import { Chevron } from "../../shared/Chevron";
import { PlusIcon } from "../../shared/icons";
import { usage } from "../../shared/ipc";
import { Group, GroupLabel, field, primaryButton } from "../settings/ui";
import { formatDuration, localDay, sectionLabel } from "./format";
import {
  hostFor,
  limitSites,
  limitStatus,
  siteParts,
  suggestHosts,
  thresholdsOf,
  type LimitSite,
} from "./limits";
import { LimitEditor } from "./LimitEditor";
import { sectionUsageSeconds, usageSeconds, useUsageControl, type UsagePolicy } from "./policy";
import { SiteBadge } from "./SiteBadge";
import { settleUsageWrites } from "./tracker";
import { statusText, UsageMeter } from "./UsageMeter";
import { useUsageView } from "./view";

const NO_HISTORY: string[] = [];

function summaryOf(policy: UsagePolicy | undefined, t: Translate): string {
  const { warn, limit } = thresholdsOf(policy);
  const limitText = limit === null ? "" : formatDuration(limit * 60, t);
  const warnText = warn === null ? "" : formatDuration(warn * 60, t);
  if (limit !== null && warn !== null) {
    return t("usage.summaryBoth", { limit: limitText, warn: warnText });
  }
  if (limit !== null) return t("usage.summaryLimit", { limit: limitText });
  if (warn !== null) return t("usage.summaryWarn", { warn: warnText });
  return t("usage.summaryNone");
}

function StatusChip({ policy, spent }: { policy: UsagePolicy | undefined; spent: number }) {
  const t = useT();
  const status = limitStatus(policy, spent);
  if (status.state === "none") return null;
  const reached = status.state === "reached";
  const text = reached
    ? t("usage.chipPaused")
    : status.untilLimit !== null
      ? t("usage.statusLeft", { value: formatDuration(status.untilLimit, t) })
      : status.untilWarn === 0
        ? t("usage.chipReminded")
        : "";
  if (!text) return null;
  const tone = reached
    ? "bg-danger/15 text-danger"
    : status.state === "warned"
      ? "bg-warn/15 text-warn"
      : "bg-paper/[0.08] text-paper/70";
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium tabular-nums ${tone}`}>
      {text}
    </span>
  );
}

interface PartRowProps {
  host: string;
  section: string;
  policy: UsagePolicy | undefined;
  spent: number;
  open: boolean;
  onToggle: () => void;
}

/** One part of a site: what it cost today, and the limit the user set for it. */
function PartRow({ host, section, policy, spent, open, onToggle }: PartRowProps) {
  const t = useT();
  const status = limitStatus(policy, spent);
  return (
    <li className="border-t border-hair">
      <div className="px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium">{sectionLabel(section, t)}</span>
          <span className="shrink-0 text-sm text-paper/60 tabular-nums">
            {formatDuration(Math.floor(spent), t)}
          </span>
        </div>
        {status.state !== "none" && (
          <div className="mt-2">
            <UsageMeter spentSeconds={spent} policy={policy} compact />
            <p className="mt-1 text-xs text-paper/55">{statusText(status, t, true)}</p>
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="mt-2 text-sm font-medium text-accent"
        >
          {policy ? t("usage.partChangeLimit") : t("usage.partSetLimit")}
        </button>
      </div>
      {open && <LimitEditor host={host} section={section} policy={policy} spentSeconds={spent} />}
    </li>
  );
}

interface LimitRowProps {
  site: LimitSite;
  policy: UsagePolicy | undefined;
  spent: number;
  parts: string[];
  open: boolean;
  scrollTo: boolean;
  openPart: string | null;
  onToggle: () => void;
  onTogglePart: (section: string) => void;
}

function LimitRow({
  site,
  policy,
  spent,
  parts,
  open,
  scrollTo,
  openPart,
  onToggle,
  onTogglePart,
}: LimitRowProps) {
  const t = useT();
  const row = useRef<HTMLDivElement>(null);
  const name = site.name ?? site.host;
  const limits = useUsageControl((s) => s.limits);
  const sectionSeconds = useUsageControl((s) => s.sectionSeconds);

  useEffect(() => {
    if (scrollTo) row.current?.scrollIntoView({ block: "start" });
  }, [scrollTo]);

  return (
    <div ref={row} className="scroll-mt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-paper/[0.05]"
      >
        <SiteBadge host={site.host} name={name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium">{name}</span>
          <span className="block text-sm leading-snug text-paper/55">{summaryOf(policy, t)}</span>
        </span>
        <StatusChip policy={policy} spent={spent} />
        <Chevron open={open} />
      </button>
      {open && (
        <>
          <LimitEditor host={site.host} section={null} policy={policy} spentSeconds={spent} />
          {parts.length > 0 && (
            <div>
              <p className="px-4 pt-5 pb-3 text-sm font-semibold text-paper/60">
                {t("usage.partsTitle")}
              </p>
              <ul>
                {parts.map((section) => (
                  <PartRow
                    key={section}
                    host={site.host}
                    section={section}
                    policy={limits.sections[site.host]?.[section]}
                    spent={sectionUsageSeconds(sectionSeconds, site.host, section)}
                    open={openPart === section}
                    onToggle={() => onTogglePart(section)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface AddSiteProps {
  suggestions: string[];
  onAdd: (host: string) => void;
}

function AddSite({ suggestions, onAdd }: AddSiteProps) {
  const t = useT();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const host = hostFor(value);
    if (!host) {
      setError(t("usage.invalidAddress"));
      return;
    }
    setValue("");
    setError("");
    onAdd(host);
  };

  return (
    <div>
      <form onSubmit={submit} className="flex items-start gap-2">
        <input
          aria-label={t("usage.siteAddress")}
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError("");
          }}
          placeholder="example.com"
          dir="ltr"
          className={`${field} text-start`}
        />
        <button type="submit" className={`${primaryButton} h-[46px] shrink-0`}>
          {t("usage.add")}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 px-1 text-sm text-danger">
          {error}
        </p>
      )}
      {suggestions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {suggestions.map((host) => (
            <button
              key={host}
              type="button"
              onClick={() => onAdd(host)}
              className="flex items-center gap-1.5 rounded-full border border-hair py-1.5 ps-2.5 pe-3.5 text-sm text-paper/85 active:bg-paper/[0.08]"
            >
              <PlusIcon />
              {host}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Every favorite with its daily limit one tap away, then the other sites that have one. */
export function LimitsTab() {
  const t = useT();
  const favorites = useApp((s) => s.state?.favorites);
  const history = useApp((s) => s.state?.history) ?? NO_HISTORY;
  const reportError = useApp((s) => s.reportError);
  const limits = useUsageControl((s) => s.limits);
  const seconds = useUsageControl((s) => s.seconds);
  const focusHost = useUsageView((s) => s.focusHost);
  const focusSection = useUsageView((s) => s.focusSection);
  const [open, setOpen] = useState<string | null>(focusHost);
  const [openPart, setOpenPart] = useState<string | null>(focusSection);
  const [scrollTo] = useState<string | null>(focusHost);
  const [added, setAdded] = useState<string[]>(focusHost ? [focusHost] : []);
  const [used, setUsed] = useState<Record<string, string[]>>({});

  useEffect(() => {
    useUsageView.getState().clearFocus();
  }, []);

  useEffect(() => {
    let alive = true;
    settleUsageWrites()
      .then(() => usage.report(localDay(new Date()), 30))
      .then((report) => {
        if (!alive) return;
        setUsed(
          Object.fromEntries(
            report.sites.map((site) => [site.host, site.sections.map((part) => part.section)]),
          ),
        );
      })
      .catch((error: unknown) => reportError(describeError(error, t)));
    return () => {
      alive = false;
    };
  }, [reportError, t]);

  const sites = useMemo(
    () => limitSites(favorites ?? [], limits.sites, added),
    [favorites, limits.sites, added],
  );
  const suggestions = useMemo(() => {
    const taken = new Set([...sites.favorites, ...sites.others].map((site) => site.host));
    return suggestHosts(history, seconds, taken);
  }, [history, seconds, sites]);

  const renderRow = (site: LimitSite) => (
    <LimitRow
      key={site.host}
      site={site}
      policy={limits.sites[site.host]}
      spent={usageSeconds(seconds, site.host)}
      parts={siteParts(site.host, used[site.host] ?? [], limits.sections)}
      open={open === site.host}
      scrollTo={scrollTo === site.host}
      openPart={openPart}
      onToggle={() => {
        setOpen(open === site.host ? null : site.host);
        setOpenPart(null);
      }}
      onTogglePart={(section) => setOpenPart(openPart === section ? null : section)}
    />
  );

  const add = (host: string) => {
    setAdded((current) => (current.includes(host) ? current : [...current, host]));
    setOpen(host);
  };

  return (
    <div className="flex flex-col gap-7">
      <p className="px-1 text-sm leading-relaxed text-paper/60">{t("usage.limitsIntro")}</p>

      <section>
        <GroupLabel>{t("usage.groupFavorites")}</GroupLabel>
        {sites.favorites.length > 0 ? (
          <Group>{sites.favorites.map(renderRow)}</Group>
        ) : (
          <p className="px-1 text-sm text-paper/50">{t("usage.noFavorites")}</p>
        )}
      </section>

      {sites.others.length > 0 && (
        <section>
          <GroupLabel>{t("usage.groupOther")}</GroupLabel>
          <Group>{sites.others.map(renderRow)}</Group>
        </section>
      )}

      <section>
        <GroupLabel>{t("usage.groupAdd")}</GroupLabel>
        <AddSite suggestions={suggestions} onAdd={add} />
      </section>
    </div>
  );
}
