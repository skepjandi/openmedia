import { lazy, Suspense, useEffect, useState } from "react";
import { AssistantDock } from "../features/ai/AssistantDock";
import { BackButton } from "../features/back/BackButton";
import { Fab } from "../features/fab/Fab";
import { CommandBar } from "../features/sheet/CommandBar";
import { HistorySheet } from "../features/history/HistorySheet";
import { startUsageTracking } from "../features/stats/tracker";
import { UsageGuard } from "../features/stats/UsageGuard";
import { WebLayer } from "../features/web/WebLayer";
import { useApplyTheme } from "../shared/theme";
import { hideSplash, hideSplashWhen, pageShowing } from "./splash";
import { selectLocale, selectPage, selectSettingsOpen, useApp } from "./store";
import { useHitRegions } from "./useHitRegions";
import { useAndroidBack } from "../features/back/useAndroidBack";
import { useBackHandler } from "../features/back/useBackHandler";
import { useDesktopInput } from "../features/desktop/useDesktopInput";
import { localeInfo } from "../i18n/locales";
import { useT } from "../i18n/useT";
import { PaywallSheet } from "../features/paywall/PaywallSheet";
import { useEntitlementStore } from "../features/paywall/store";

/** Heavy screens load after the first page shows; most launches never open them. */
const loadSettings = () => import("../features/settings/SettingsScreen");
const loadStats = () => import("../features/stats/StatsSheet");
const loadOnboarding = () => import("../features/onboarding/Onboarding");
const loadRecipes = () => import("../features/settings/RecipesScreen");
const SettingsScreen = lazy(() =>
  loadSettings().then((module) => ({ default: module.SettingsScreen })),
);
const StatsSheet = lazy(() => loadStats().then((module) => ({ default: module.StatsSheet })));
const RecipesScreen = lazy(() =>
  loadRecipes().then((module) => ({ default: module.RecipesScreen })),
);
const Onboarding = lazy(() => loadOnboarding().then((module) => ({ default: module.Onboarding })));

function firstPageShowing(): boolean {
  const store = useApp.getState();
  return store.error !== null || pageShowing(selectPage(store));
}

export function App() {
  const load = useApp((s) => s.load);
  const loadSecondary = useApp((s) => s.loadSecondary);
  const error = useApp((s) => s.error);
  const sheet = useApp((s) => s.sheet);
  const settingsOpen = useApp(selectSettingsOpen);
  const onboardingOpen = useApp((s) => s.onboardingOpen);
  const reportError = useApp((s) => s.reportError);
  const closeSheet = useApp((s) => s.closeSheet);
  const theme = useApp((s) => s.state?.theme ?? "system");
  const locale = useApp(selectLocale);
  const incognito = useApp((s) => s.incognito.active);
  const desktop = useApp((s) => s.desktop);
  const t = useT();
  const [idle, setIdle] = useState(false);
  useApplyTheme(theme);
  useHitRegions();
  useAndroidBack();
  useDesktopInput();
  useBackHandler(sheet !== "none", closeSheet);
  useEffect(() => {
    void useEntitlementStore.getState().initialize();
    return useEntitlementStore.subscribe((state, previous) => {
      if (previous.status === "pro" && state.status !== "pro" && useApp.getState().incognito.active)
        void useApp.getState().exitIncognito();
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = localeInfo(locale).dir;
  }, [locale]);

  useEffect(() => {
    document.documentElement.dataset.incognito = String(incognito);
  }, [incognito]);

  useEffect(() => {
    document.documentElement.dataset.desktop = String(desktop);
  }, [desktop]);

  useEffect(() => startUsageTracking(), []);

  useEffect(() => {
    void load()
      .then(() => hideSplashWhen(firstPageShowing, useApp.subscribe), hideSplash)
      .then(() => {
        loadSecondary();
        void Promise.all([loadSettings(), loadStats()]);
        setIdle(true);
      });
  }, [load, loadSecondary]);

  return (
    <>
      <WebLayer />
      <UsageGuard />
      <Fab />
      <BackButton />
      <CommandBar />
      <AssistantDock />
      <HistorySheet />
      <Suspense fallback={null}>
        {(idle || settingsOpen) && <SettingsScreen />}
        {(idle || sheet === "recipes") && <RecipesScreen />}
        {(idle || sheet === "stats") && <StatsSheet />}
        {onboardingOpen && <Onboarding />}
        {sheet === "paywall" && <PaywallSheet />}
      </Suspense>
      {error && !settingsOpen && (
        <button
          type="button"
          data-hit=""
          data-dock="bottom"
          onClick={() => reportError(null)}
          className="glass fixed inset-x-3 bottom-[calc(var(--safe-bottom)+12px)] z-20 rounded-2xl px-4 py-3 text-start text-sm text-accent"
        >
          {error}
          <span className="mt-1 block text-xs text-paper/50">{t("app.dismiss")}</span>
        </button>
      )}
    </>
  );
}
