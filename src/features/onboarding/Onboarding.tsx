import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { appError, useApp } from "../../app/store";
import logoMark from "../../assets/logo-mark.svg";
import { useT } from "../../i18n/useT";
import type { MessageKey } from "../../i18n/messages";
import { HistoryIcon, IncognitoIcon, SlidersIcon, StatsIcon } from "../../shared/icons";
import { useBackHandler } from "../back/useBackHandler";
import { onboarding } from "../library/ipc";
import { useEntitlementStore } from "../paywall/store";
import { QuickAccessStep, type OptionsState } from "./QuickAccessStep";
import { quickAccessLimit, toggleSelection } from "./selection";

interface DemoItemStyle extends CSSProperties {
  "--i": number;
  "--from-x": string;
  "--from-y": string;
}

function MiniButton({ pulsing }: { pulsing?: boolean }) {
  return (
    <span className="fab relative grid size-16 place-items-center rounded-full">
      {pulsing && (
        <span className="demo-ring absolute inset-0 rounded-full border-2 border-accent" />
      )}
      <img src={logoMark} alt="" className="relative size-10" />
    </span>
  );
}

function BrandVisual() {
  return (
    <div className="grid size-56 place-items-center">
      <div className="relative grid size-40 place-items-center rounded-[2.5rem] bg-white shadow-[0_20px_60px_rgb(6_175_248/0.25)]">
        <img src={logoMark} alt="" className="size-24" />
      </div>
    </div>
  );
}

function TapVisual() {
  const t = useT();
  return (
    <div className="relative grid size-56 place-items-center">
      <span className="demo-tap absolute size-14 rounded-full border-2 border-accent" />
      <MiniButton />
      <span className="absolute bottom-6 rounded-full border border-hair px-3 py-1 text-xs tracking-[0.14em] text-paper/70 uppercase">
        {t("onboarding.tap")}
      </span>
    </div>
  );
}

/** Offsets from the button's centre, in px. Favorites arc out; the four controls stack above it. */
const DEMO_FAVORITES = [
  { label: "I", x: 70, y: -100 },
  { label: "F", x: 114, y: -50 },
  { label: "T", x: 128, y: 0 },
  { label: "R", x: 114, y: 50 },
  { label: "Y", x: 70, y: 100 },
];

const DEMO_CONTROLS = [
  { key: "incognito", icon: <IncognitoIcon />, y: -188 },
  { key: "usage", icon: <StatsIcon />, y: -146 },
  { key: "history", icon: <HistoryIcon />, y: -104 },
  { key: "settings", icon: <SlidersIcon />, y: -62 },
];

const DEMO_BUTTON_CENTER = { x: 56, y: 214 };

function demoItemStyle(index: number, x: number, y: number, size: number): DemoItemStyle {
  return {
    "--i": index,
    "--from-x": `${-x}px`,
    "--from-y": `${-y}px`,
    left: DEMO_BUTTON_CENTER.x + x - size / 2,
    top: DEMO_BUTTON_CENTER.y + y - size / 2,
    width: size,
    height: size,
  };
}

function HoldVisual() {
  return (
    <div className="relative h-80 w-64">
      <div className="absolute" style={{ left: 24, top: DEMO_BUTTON_CENTER.y - 32 }}>
        <MiniButton pulsing />
      </div>
      {DEMO_FAVORITES.map((item, i) => (
        <span
          key={item.label}
          className="demo-fan-item glass absolute grid place-items-center rounded-full text-base font-medium"
          style={demoItemStyle(i, item.x, item.y, 48)}
        >
          {item.label}
        </span>
      ))}
      {DEMO_CONTROLS.map((item, i) => (
        <span
          key={item.key}
          className="demo-fan-item glass absolute grid place-items-center rounded-full text-paper/70"
          style={demoItemStyle(DEMO_FAVORITES.length + i, 0, item.y, 36)}
        >
          {item.icon}
        </span>
      ))}
    </div>
  );
}

function DragVisual() {
  return (
    <div className="relative h-56 w-56">
      <div className="absolute inset-y-0 right-3 w-px bg-hair" />
      <div className="demo-slide absolute top-1/2 right-0 -mt-7">
        <MiniButton />
      </div>
    </div>
  );
}

interface Step {
  title: MessageKey;
  body: MessageKey;
  visual: ReactNode;
}

const STEPS: Step[] = [
  {
    title: "onboarding.step1Title",
    body: "onboarding.step1Body",
    visual: <BrandVisual />,
  },
  {
    title: "onboarding.step2Title",
    body: "onboarding.step2Body",
    visual: <TapVisual />,
  },
  {
    title: "onboarding.step3Title",
    body: "onboarding.step3Body",
    visual: <HoldVisual />,
  },
  {
    title: "onboarding.step4Title",
    body: "onboarding.step4Body",
    visual: <DragVisual />,
  },
];

const QUICK_STEP = STEPS.length;
const LIBRARY_STEP = STEPS.length + 1;
const STEP_COUNT = STEPS.length + 2;

const LIBRARY_POINTS: MessageKey[] = [
  "onboarding.libraryOfficial",
  "onboarding.libraryChecked",
  "onboarding.libraryReview",
  "onboarding.libraryShare",
];

/** First-run guide, also reachable from Settings. Full-screen so the page cannot be touched. */
export function Onboarding() {
  const open = useApp((s) => s.onboardingOpen);
  // Mounted only while open, so replaying the guide from Settings starts with no old picks.
  return open ? <OnboardingBody /> : null;
}

function OnboardingBody() {
  const finishGuide = useApp((s) => s.finishGuide);
  const loadSites = useApp((s) => s.loadSites);
  const reloadFavorites = useApp((s) => s.reloadFavorites);
  const isPro = useEntitlementStore((s) => s.status === "pro");
  const t = useT();
  const [index, setIndex] = useState(0);
  const [reachedQuick, setReachedQuick] = useState(false);
  const [options, setOptions] = useState<OptionsState>({ status: "loading" });
  const [selected, setSelected] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [notAdded, setNotAdded] = useState<string[] | null>(null);
  useBackHandler(index > 0, () => setIndex(index - 1));

  const fetchOptions = useCallback(() => {
    onboarding
      .options()
      .then((found) => setOptions({ status: "ready", options: found }))
      .catch((failure: unknown) => setOptions({ status: "error", message: appError(failure) }));
  }, []);

  // Fetched when the step is first reached, so skipping never waits on the network.
  useEffect(() => {
    if (reachedQuick) fetchOptions();
  }, [reachedQuick, fetchOptions]);

  const retryOptions = () => {
    setOptions({ status: "loading" });
    fetchOptions();
  };

  const go = (next: number) => {
    setIndex(next);
    if (next >= QUICK_STEP) setReachedQuick(true);
  };

  const quick = index === QUICK_STEP;
  const libraryStep = index === LIBRARY_STEP;
  const step = index < STEPS.length ? STEPS[index] : null;
  const last = index === STEP_COUNT - 1;
  const limit = quickAccessLimit(isPro);

  const finish = async () => {
    if (selected.length === 0 || notAdded !== null) {
      void finishGuide();
      return;
    }
    setApplying(true);
    setApplyError(null);
    try {
      const result = await onboarding.apply(selected).finally(() =>
        // Installs and favorites are saved one by one, so even a failed apply may have changed
        // them: the lists must be re-read either way.
        Promise.all([loadSites(), reloadFavorites()]),
      );
      if (result.failed.length === 0) {
        void finishGuide();
        return;
      }
      const names = new Map(
        options.status === "ready" ? options.options.map((o) => [o.recipeId, o.name]) : [],
      );
      setNotAdded(result.failed.map((id) => names.get(id) ?? id));
    } catch (failure) {
      setApplyError(appError(failure));
    } finally {
      setApplying(false);
    }
  };

  const nextLabel = () => {
    if (!last) return t("onboarding.next");
    if (applying) return t("onboarding.applying");
    return applyError ? t("common.retry") : t("onboarding.start");
  };

  return (
    <div
      data-hit=""
      role="dialog"
      aria-modal="true"
      aria-label={t("onboarding.label")}
      className="fixed inset-0 z-[60] flex flex-col bg-ink px-6 pt-[calc(var(--safe-top)+12px)] pb-[calc(var(--safe-bottom)+20px)]"
    >
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void finishGuide()}
          className="px-2 py-3 text-xs tracking-[0.2em] text-paper/60 uppercase"
        >
          {t("onboarding.skip")}
        </button>
      </div>

      {step && <div className="flex flex-1 items-center justify-center">{step.visual}</div>}

      {quick && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 pb-4">
          <div>
            <p className="text-xs tracking-[0.22em] text-accent uppercase">
              {index + 1} / {STEP_COUNT}
            </p>
            <h1 className="mt-2 text-3xl leading-[1.05] font-semibold tracking-tight">
              {t("onboarding.quickTitle")}
            </h1>
            <p className="mt-2 max-w-sm text-base leading-snug text-paper/65">
              {t("onboarding.quickBody")}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <QuickAccessStep
              options={options}
              selected={selected}
              limit={limit}
              isPro={isPro}
              onToggle={(id) => setSelected((current) => toggleSelection(current, id, limit))}
              onRetry={retryOptions}
            />
          </div>
        </div>
      )}

      {libraryStep && (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-4 overflow-y-auto">
          <div>
            <p className="text-xs tracking-[0.22em] text-accent uppercase">
              {index + 1} / {STEP_COUNT}
            </p>
            <h1 className="mt-2 text-4xl leading-[1.05] font-semibold tracking-tight">
              {t("onboarding.libraryTitle")}
            </h1>
            <p className="mt-3 max-w-sm text-base leading-relaxed text-paper/65">
              {t("onboarding.libraryBody")}
            </p>
          </div>
          <ul className="flex max-w-sm flex-col gap-2.5 text-sm leading-snug text-paper/75">
            {LIBRARY_POINTS.map((point) => (
              <li key={point} className="flex gap-2.5">
                <span aria-hidden="true" className="text-accent">
                  •
                </span>
                {t(point)}
              </li>
            ))}
          </ul>
          {applyError && <p className="text-sm text-paper/80">{applyError}</p>}
          {notAdded && (
            <p className="text-sm text-paper/80">
              {t("onboarding.partial", { names: notAdded.join(", ") })}
            </p>
          )}
        </div>
      )}

      {step && (
        <div className="min-h-44">
          <p className="text-xs tracking-[0.22em] text-accent uppercase">
            {index + 1} / {STEP_COUNT}
          </p>
          <h1 className="mt-2 text-4xl leading-[1.05] font-semibold tracking-tight">
            {t(step.title)}
          </h1>
          <p className="mt-3 max-w-sm text-base leading-relaxed text-paper/65">{t(step.body)}</p>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <div className="flex gap-2" aria-hidden="true">
          {Array.from({ length: STEP_COUNT }, (_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === index ? "w-6 bg-accent" : "w-1.5 bg-paper/25"
              }`}
            />
          ))}
        </div>
        <div className="flex gap-3">
          {index > 0 && (
            <button
              type="button"
              disabled={applying}
              onClick={() => go(index - 1)}
              className="rounded-full border border-hair px-5 py-3 text-base text-paper/80"
            >
              {t("common.back")}
            </button>
          )}
          <button
            type="button"
            disabled={applying}
            onClick={() => (last ? void finish() : go(index + 1))}
            className="rounded-full bg-accent px-6 py-3 text-base font-semibold text-on-accent disabled:opacity-60"
          >
            {nextLabel()}
          </button>
        </div>
      </div>
    </div>
  );
}
