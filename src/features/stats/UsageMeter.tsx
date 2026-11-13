import { useT } from "../../i18n/useT";
import type { Translate } from "../../i18n/translate";
import { formatDuration } from "./format";
import { limitStatus, type LimitStatus } from "./limits";
import type { UsagePolicy } from "./policy";

const FILL: Record<LimitStatus["state"], string> = {
  none: "bg-accent",
  ok: "bg-accent",
  warned: "bg-warn",
  reached: "bg-danger",
};

/** The colour of the sentence that says where a limit stands. */
export const STATUS_TEXT: Record<LimitStatus["state"], string> = {
  none: "text-paper/55",
  ok: "text-paper/70",
  warned: "text-warn",
  reached: "text-danger",
};

/** One line saying where today stands against the limit. Empty when nothing is set. */
export function statusText(status: LimitStatus, t: Translate, part = false): string {
  if (status.state === "reached") {
    return part ? t("usage.partStatusReached") : t("usage.statusReached");
  }
  if (status.untilLimit !== null) {
    return t("usage.statusLeft", { value: formatDuration(status.untilLimit, t) });
  }
  if (status.untilWarn !== null) {
    return status.untilWarn === 0
      ? t("usage.statusPastReminder")
      : t("usage.statusReminderIn", { value: formatDuration(status.untilWarn, t) });
  }
  return "";
}

interface UsageMeterProps {
  spentSeconds: number;
  policy: UsagePolicy | undefined;
  /** A thinner bar, for rows that already carry other content. */
  compact?: boolean;
}

/** Today's time as a bar that fills toward the limit, with a tick where the reminder fires. */
export function UsageMeter({ spentSeconds, policy, compact = false }: UsageMeterProps) {
  const t = useT();
  const status = limitStatus(policy, spentSeconds);
  if (status.state === "none") return null;
  const scale = policy?.limitSeconds ?? policy?.warnSeconds ?? 0;
  const spent = Math.floor(spentSeconds);
  return (
    <div
      role="meter"
      aria-label={t("usage.meterLabel")}
      aria-valuemin={0}
      aria-valuemax={scale}
      aria-valuenow={Math.min(spent, scale)}
      aria-valuetext={t("usage.meterText", {
        used: formatDuration(spent, t),
        status: statusText(status, t),
      })}
      className={`relative rounded-full bg-paper/12 ${compact ? "h-1.5" : "h-2"}`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${FILL[status.state]}`}
        style={{ width: `${Math.max(status.fraction, 0.02) * 100}%` }}
      />
      {status.warnFraction !== null && (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-paper/60"
          style={{ insetInlineStart: `${status.warnFraction * 100}%` }}
        />
      )}
    </div>
  );
}

/** "25m today · 5m left", coloured by state. */
export function MeterCaption({
  spentSeconds,
  policy,
}: {
  spentSeconds: number;
  policy: UsagePolicy | undefined;
}) {
  const t = useT();
  const status = limitStatus(policy, spentSeconds);
  const today = t("usage.todayValue", { value: formatDuration(Math.floor(spentSeconds), t) });
  return (
    <p className={`text-sm tabular-nums ${STATUS_TEXT[status.state]}`}>
      {status.state === "none"
        ? today
        : t("usage.todayStatus", {
            value: formatDuration(Math.floor(spentSeconds), t),
            status: statusText(status, t),
          })}
    </p>
  );
}
