import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { QUICK_ACCESS_LIMIT } from "../../shared/favorites";
import { FavoritesEditor } from "./FavoritesSection";
import { SiteCard } from "./RecipesScreen";
import { LockedSection } from "./ui";

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
  const t = useT();

  return (
    <LockedSection
      title={t("incognito.favoritesTitle")}
      note={t("incognito.favoritesNote", { limit: QUICK_ACCESS_LIMIT })}
      lockedHint={t("incognito.locked")}
      unlock={unlock}
      onUnlocked={load}
      onLocked={forget}
    >
      <FavoritesEditor
        favorites={favorites}
        save={save}
        emptyText={t("incognito.favoritesEmpty")}
      />
    </LockedSection>
  );
}

/** The recipe switches that apply while incognito, kept apart from the normal ones. */
export function IncognitoRecipesSection() {
  const sites = useApp((s) => s.incognitoSites);
  const unlock = useApp((s) => s.unlockIncognito);
  const load = useApp((s) => s.loadIncognitoSites);
  const forget = useApp((s) => s.forgetIncognitoSites);
  const t = useT();

  return (
    <LockedSection
      title={t("incognito.recipesTitle")}
      note={t("incognito.recipesNote")}
      lockedHint={t("incognito.locked")}
      unlock={unlock}
      onUnlocked={load}
      onLocked={forget}
    >
      <div className="flex flex-col gap-3">
        {sites.map((site) => (
          <SiteCard key={site.recipeId} site={site} incognito />
        ))}
      </div>
    </LockedSection>
  );
}
