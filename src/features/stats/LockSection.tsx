import { useEffect, useState } from "react";
import { appError, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { BiometricIcon } from "../incognito/BiometricIcon";
import { primaryButton, quietButton } from "../settings/ui";
import { formatDuration } from "./format";
import { remainingAt, usageLock, useUsageLock } from "./lock";

const TICK_MS = 30_000;

function useCountdown(): number {
  const status = useUsageLock((state) => state.status);
  const readAt = useUsageLock((state) => state.readAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status.phase !== "coolingOff") return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [status.phase]);
  return remainingAt(status, readAt, now);
}

/**
 * The settings lock card in Limits: turn the lock on, ask to unlock (a Face ID, Touch ID or
 * passcode check, then 24 hours), cancel the request, or lift the lock once the wait is over.
 * Rust holds the state and the request time; this only shows it.
 */
export function LockSection() {
  const t = useT();
  const status = useUsageLock((state) => state.status);
  const reportError = useApp((state) => state.reportError);
  const [busy, setBusy] = useState(false);
  const remaining = useCountdown();

  useEffect(() => {
    usageLock.load().catch((error: unknown) => reportError(appError(error)));
  }, [reportError]);

  useEffect(() => {
    if (status.phase === "coolingOff" && remaining === 0) {
      usageLock.load().catch((error: unknown) => reportError(appError(error)));
    }
  }, [status.phase, remaining, reportError]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      reportError(appError(error));
    } finally {
      setBusy(false);
    }
  };

  const checked = (label: string) => (
    <>
      <BiometricIcon size={18} />
      {label}
    </>
  );

  return (
    <section
      aria-label={t("usage.lock.title")}
      className="rounded-2xl border border-hair bg-paper/[0.04] p-4"
    >
      <h2 className="text-base font-semibold">{t("usage.lock.title")}</h2>
      <p className="mt-1 text-sm leading-relaxed text-paper/60">{t("usage.lock.intro")}</p>
      <p role="status" className="mt-3 text-sm font-medium">
        {status.phase === "off" && t("usage.lock.off")}
        {status.phase === "locked" && t("usage.lock.locked")}
        {status.phase === "coolingOff" &&
          t("usage.lock.cooling", { value: formatDuration(remaining, t) })}
        {status.phase === "ready" && t("usage.lock.ready")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {status.phase === "off" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(usageLock.enable)}
            className={primaryButton}
          >
            {t("usage.lock.enable")}
          </button>
        )}
        {status.phase === "locked" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => usageLock.requestUnlock(t("usage.lock.reasonRequest")))}
            className={`${quietButton} flex items-center gap-2`}
          >
            {checked(t("usage.lock.requestUnlock"))}
          </button>
        )}
        {status.phase === "ready" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(usageLock.lift)}
            className={primaryButton}
          >
            {t("usage.lock.lift")}
          </button>
        )}
        {(status.phase === "coolingOff" || status.phase === "ready") && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => usageLock.cancelUnlock(t("usage.lock.reasonCancel")))}
            className={`${quietButton} flex items-center gap-2`}
          >
            {checked(status.phase === "ready" ? t("usage.lock.keep") : t("usage.lock.cancel"))}
          </button>
        )}
      </div>
    </section>
  );
}
