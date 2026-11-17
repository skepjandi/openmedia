import { useState } from "react";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { Switch } from "../settings/Switch";
import { formatDuration } from "./format";
import { pauseRelaxes, refusesRelaxing, useUsageLock } from "./lock";
import { DEFAULT_PAUSE_SECONDS, PAUSE_STOPS } from "./pause";
import { usageLimits } from "./policy";

/**
 * One site's pause screen: how many seconds it waits, with a breathing circle, before the site
 * opens or when the reader comes back to it. Off removes it for this site; the switch in Limits
 * turns every pause screen off at once. The settings lock refuses a shorter delay or none.
 */
export function PauseEditor({ host, seconds }: { host: string; seconds: number | undefined }) {
  const t = useT();
  const phase = useUsageLock((state) => state.status.phase);
  const [error, setError] = useState("");

  const save = async (next: number | null) => {
    if (refusesRelaxing(phase) && pauseRelaxes(seconds, next)) {
      return setError(t("usage.lock.refused"));
    }
    setError("");
    try {
      await usageLimits.setPause(host, next);
    } catch (cause) {
      setError(describeError(cause, t));
    }
  };

  return (
    <div className="border-t border-hair bg-paper/[0.03]">
      <Switch
        label={t("usage.pauseScreenTitle")}
        description={t("usage.pauseScreenHint")}
        checked={seconds !== undefined}
        onChange={(on) => void save(on ? DEFAULT_PAUSE_SECONDS : null)}
      />
      {seconds !== undefined && (
        <div
          role="group"
          aria-label={t("usage.pauseScreenTitle")}
          className="flex flex-wrap gap-2 px-4 pb-4"
        >
          {PAUSE_STOPS.map((stop) => (
            <button
              key={stop}
              type="button"
              aria-pressed={seconds === stop}
              onClick={() => void save(stop)}
              className={`min-h-9 rounded-full px-3.5 text-sm font-medium tabular-nums ${
                seconds === stop ? "bg-accent text-on-accent" : "border border-hair text-paper/75"
              }`}
            >
              {formatDuration(stop, t)}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="px-4 pb-3 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
