import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { QUICK_ACCESS_LIMIT } from "../../shared/favorites";
import { ForwardIcon, ProIcon } from "../../shared/icons";
import { Screen } from "../../shared/Screen";
import { BiometricIcon } from "../incognito/BiometricIcon";
import { useEntitlementStore } from "../paywall/store";
import { FavoritesEditor } from "./FavoritesSection";
import { SiteCard } from "./RecipesScreen";
import { Group, LockedSection } from "./ui";

/**
 * The quick-access set shown while incognito. Collapsed and locked: opening it asks for Face ID,
 * Touch ID or the passcode, and closing it forgets what it loaded.
 */
export function IncognitoFavoritesSection() {
  const favorites = useApp((s) => s.incognito.favorites);
  const unlock = useApp((s) => s.unlockIncognito);
  const load = useApp((s) => s.loadIncognitoFavorites);
  const forget = useApp((s) => s.forgetIncognitoFavorites);
  const save = useApp((s) => s.saveIncognitoFavorites);
  const needsPro = useEntitlementStore((s) => s.status !== "pro");
  const t = useT();

  return (
    <LockedSection
      title={t("incognito.favoritesTitle")}
      note={t("incognito.favoritesNote", { limit: QUICK_ACCESS_LIMIT })}
      lockedHint={needsPro ? t("paywall.locked") : t("incognito.locked")}
      needsPro={needsPro}
      unlock={unlock}
      onUnlocked={load}
      onLocked={forget}
    >
      <FavoritesEditor
        favorites={favorites}
        save={save}
        emptyText={t("incognito.favoritesEmpty")}
        recipeSheet="incognito-recipes"
      />
    </LockedSection>
  );
}

/**
 * Opens the incognito recipe list, separate from Settings. The row itself asks for the
 * biometric check, so the page it opens lists the recipes right away.
 */
export function IncognitoRecipesLink() {
  const openSheet = useApp((s) => s.openSheet);
  const unlock = useApp((s) => s.unlockIncognito);
  const needsPro = useEntitlementStore((s) => s.status !== "pro");
  const [checking, setChecking] = useState(false);
  const incognitoActive = useApp((s) => s.incognito.active);
  const t = useT();

  const open = async () => {
    if (checking) return;
    setChecking(true);
    try {
      // Without Pro the check opens the paywall and fails, so the page stays closed.
      if (!(await unlock())) return;
      openSheet("incognito-recipes");
    } finally {
      setChecking(false);
    }
  };

  return (
    <Group>
      <button
        type="button"
        onClick={() => void open()}
        disabled={checking}
        aria-busy={checking}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-paper/[0.05] disabled:opacity-60"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{t("incognito.recipesTitle")}</span>
          <span className="block text-sm text-paper/55">{t("incognito.locked")}</span>
        </span>
        {needsPro ? (
          <span className="pro-badge grid size-6 shrink-0 place-items-center rounded-full">
            <ProIcon size={12} />
          </span>
        ) : (
          !incognitoActive && (
            <span aria-hidden="true" className="shrink-0 text-paper/45">
              <BiometricIcon size={18} />
            </span>
          )
        )}
        <span aria-hidden="true" className="text-paper/50 rtl:-scale-x-100">
          <ForwardIcon />
        </span>
      </button>
    </Group>
  );
}

/** Incognito recipe switches have their own page, listed like the normal Recipes page. */
export function IncognitoRecipesScreen() {
  const open = useApp((s) => s.sheet === "incognito-recipes");
  const closeSheet = useApp((s) => s.closeSheet);
  const sites = useApp((s) => s.incognitoSites);
  const loadSites = useApp((s) => s.loadIncognitoSites);
  const loadFavorites = useApp((s) => s.loadIncognitoFavorites);
  const forgetSites = useApp((s) => s.forgetIncognitoSites);
  const forgetFavorites = useApp((s) => s.forgetIncognitoFavorites);
  const forget = useCallback(() => {
    forgetSites();
    forgetFavorites();
  }, [forgetSites, forgetFavorites]);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    void Promise.all([loadSites(), loadFavorites()]);
    // The incognito set is only on screen while the page is; the background locks it again.
    const lockWhenHidden = () => {
      if (!document.hidden) return;
      forget();
      closeSheet();
    };
    document.addEventListener("visibilitychange", lockWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", lockWhenHidden);
      // React remounts the page in development; only a real close forgets the set.
      if (useApp.getState().sheet !== "incognito-recipes") forget();
    };
  }, [open, loadSites, loadFavorites, forget, closeSheet]);

  if (!open) return null;

  return (
    <Screen
      title={t("incognito.recipesTitle")}
      closeLabel={t("common.back")}
      onClose={closeSheet}
      back
    >
      <p className="px-1 pb-2 text-[13px] leading-snug text-paper/50">
        {t("incognito.recipesNote")}
      </p>
      {sites.length === 0 ? (
        <p className="px-1 py-3 text-sm text-paper/60">{t("recipes.empty")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {sites.map((site) => (
            <SiteCard key={site.recipeId} site={site} incognito />
          ))}
        </div>
      )}
    </Screen>
  );
}
