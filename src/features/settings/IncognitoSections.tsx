import { useCallback } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { QUICK_ACCESS_LIMIT } from "../../shared/favorites";
import { ForwardIcon, ProIcon } from "../../shared/icons";
import { Screen } from "../../shared/Screen";
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

/** Opens the locked incognito recipe list, separate from Settings. */
export function IncognitoRecipesLink() {
  const openSheet = useApp((s) => s.openSheet);
  const needsPro = useEntitlementStore((s) => s.status !== "pro");
  const t = useT();

  return (
    <Group>
      <button
        type="button"
        onClick={() => openSheet("incognito-recipes")}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-paper/[0.05]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{t("incognito.recipesTitle")}</span>
          <span className="block text-sm text-paper/55">{t("incognito.recipesNote")}</span>
        </span>
        {needsPro && (
          <span className="pro-badge grid size-6 shrink-0 place-items-center rounded-full">
            <ProIcon size={12} />
          </span>
        )}
        <span aria-hidden="true" className="text-paper/50 rtl:-scale-x-100">
          <ForwardIcon />
        </span>
      </button>
    </Group>
  );
}

/** Incognito recipe switches have a separate page and biometric lock. */
export function IncognitoRecipesScreen() {
  const open = useApp((s) => s.sheet === "incognito-recipes");
  const closeSheet = useApp((s) => s.closeSheet);
  const sites = useApp((s) => s.incognitoSites);
  const unlock = useApp((s) => s.unlockIncognito);
  const loadSites = useApp((s) => s.loadIncognitoSites);
  const loadFavorites = useApp((s) => s.loadIncognitoFavorites);
  const forgetSites = useApp((s) => s.forgetIncognitoSites);
  const forgetFavorites = useApp((s) => s.forgetIncognitoFavorites);
  const needsPro = useEntitlementStore((s) => s.status !== "pro");
  const forget = useCallback(() => {
    forgetSites();
    forgetFavorites();
  }, [forgetSites, forgetFavorites]);
  const t = useT();
  if (!open) return null;

  return (
    <Screen
      title={t("incognito.recipesTitle")}
      closeLabel={t("common.back")}
      onClose={closeSheet}
      back
    >
      <LockedSection
        hideTitle
        title={t("incognito.recipesTitle")}
        note={t("incognito.recipesNote")}
        lockedHint={needsPro ? t("paywall.locked") : t("incognito.locked")}
        needsPro={needsPro}
        unlock={unlock}
        onUnlocked={async () => {
          await Promise.all([loadSites(), loadFavorites()]);
        }}
        onLocked={forget}
      >
        {sites.length === 0 ? (
          <p className="px-1 py-3 text-sm text-paper/60">{t("recipes.empty")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {sites.map((site) => (
              <SiteCard key={site.recipeId} site={site} incognito />
            ))}
          </div>
        )}
      </LockedSection>
    </Screen>
  );
}
