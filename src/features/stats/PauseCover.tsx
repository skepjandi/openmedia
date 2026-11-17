import { useEffect, useRef, useState } from "react";
import { selectPage, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { primaryButton, quietButton } from "../settings/ui";
import { closesSite } from "./policy";
import { needsPause, pauseDelayFor, pauseDone, usePauseCover } from "./pause";
import { nameForHost, SiteBadge, useFavorites } from "./SiteBadge";
import { useLimitBlock } from "./UsageGuard";

const MARK_MS = 5_000;
const TICK_MS = 250;

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

interface PauseScreenProps {
  host: string;
  delaySeconds: number;
  onContinue: () => void;
  onClose: () => void;
}

/** A breathing circle and a countdown. Close is always there; Continue unlocks after the delay. */
function PauseScreen({ host, delaySeconds, onContinue, onClose }: PauseScreenProps) {
  const t = useT();
  const favorites = useFavorites();
  const name = nameForHost(host, favorites);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setShown((Date.now() - startedAt) / 1000), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const done = pauseDone(delaySeconds, shown);
  const left = Math.max(0, Math.ceil(delaySeconds - shown));
  return (
    <div
      data-hit=""
      className="absolute inset-0 z-10 grid place-items-center bg-ink/60 p-8 backdrop-blur-xl pointer-events-auto"
    >
      <section
        aria-label={t("pause.label", { name })}
        className="w-full max-w-sm rounded-3xl border border-hair bg-ink/90 p-6 text-center"
      >
        <div className="flex justify-center">
          <SiteBadge host={host} name={name} />
        </div>
        <div aria-hidden="true" className="my-6 grid place-items-center">
          <div className="pause-breath grid h-28 w-28 place-items-center rounded-full bg-accent/25">
            <span className="text-3xl font-semibold tabular-nums">{done ? "" : left}</span>
          </div>
        </div>
        <h1 className="text-xl font-semibold">{t("pause.title")}</h1>
        <p role="status" className="mt-2 text-sm leading-relaxed text-paper/70">
          {done ? t("pause.ready", { name }) : t("pause.breathe", { name })}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            disabled={!done}
            onClick={onContinue}
            className={`${primaryButton} py-3 disabled:opacity-40`}
          >
            {done ? t("pause.continue") : t("pause.continueIn", { value: left })}
          </button>
          <button type="button" onClick={onClose} className={`${quietButton} py-3`}>
            {t("pause.close")}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * The optional pause before a site opens. It appears when a session with a pause delay is opened,
 * or comes back in front after being away, never while the same session stays in front. It covers
 * the page's own rectangle only, so the page keeps loading behind it, the hub bar and the fan stay
 * usable, and Close is always one tap away.
 */
export function PauseCover() {
  const { control, isPro, host, lock } = useLimitBlock();
  const page = useApp(selectPage);
  const sheet = useApp((state) => state.sheet);
  const onboarding = useApp((state) => state.onboardingOpen);
  const closeSession = useApp((state) => state.closeSession);
  const visible = useVisible();
  const paused = usePauseCover((state) => state.sessionId);
  const lastInFront = useRef(new Map<string, number>());
  const delay = host && isPro && control.ready ? pauseDelayFor(control.limits, host) : null;
  const closed = closesSite(lock);
  const latest = useRef({ delay, closed });
  useEffect(() => {
    latest.current = { delay, closed };
  });
  const front =
    page && isPro && control.ready && sheet === "none" && !onboarding && visible ? page.id : null;

  useEffect(() => {
    if (front === null) return;
    const seen = lastInFront.current;
    if (usePauseCover.getState().sessionId !== front) {
      const asks =
        latest.current.delay !== null &&
        !latest.current.closed &&
        needsPause(seen.get(front) ?? null, Date.now());
      usePauseCover.setState({ sessionId: asks ? front : null });
    }
    const mark = () => seen.set(front, Date.now());
    mark();
    const timer = window.setInterval(mark, MARK_MS);
    return () => {
      mark();
      window.clearInterval(timer);
    };
  }, [front]);

  useEffect(() => {
    if (paused !== null && delay === null) usePauseCover.setState({ sessionId: null });
  }, [paused, delay]);

  if (!page || !host || delay === null || paused !== page.id || closed) return null;
  return (
    <PauseScreen
      key={page.id}
      host={host}
      delaySeconds={delay}
      onContinue={() => usePauseCover.setState({ sessionId: null })}
      onClose={() => {
        usePauseCover.setState({ sessionId: null });
        closeSession(page.id);
      }}
    />
  );
}
