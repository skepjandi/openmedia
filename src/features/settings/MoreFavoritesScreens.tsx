import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { Screen } from "../../shared/Screen";
import { FavoritesEditor } from "./FavoritesSection";
import { useIncognitoPage } from "./IncognitoSections";

/** The favorites past quick access, with the same editing as Settings, on a page of their own. */
export function MoreFavoritesScreen() {
  const open = useApp((s) => s.sheet === "more-favorites");
  const closeSheet = useApp((s) => s.closeSheet);
  const favorites = useApp((s) => s.state?.favorites) ?? [];
  const folders = useApp((s) => s.state?.folders) ?? [];
  const save = useApp((s) => s.saveFavorites);
  const sites = useApp((s) => s.sites);
  const t = useT();
  if (!open) return null;

  return (
    <Screen
      title={t("favorites.moreLocked")}
      closeLabel={t("common.back")}
      onClose={closeSheet}
      back
    >
      <FavoritesEditor
        favorites={favorites}
        folders={folders}
        save={save}
        recipes={sites}
        recipeSheet="recipes"
        part="more"
      />
    </Screen>
  );
}

/** The same page for the incognito set, which is loaded on open and forgotten on close. */
export function IncognitoMoreFavoritesScreen() {
  const closeSheet = useApp((s) => s.closeSheet);
  const favorites = useApp((s) => s.incognito.favorites);
  const folders = useApp((s) => s.incognito.folders);
  const save = useApp((s) => s.saveIncognitoFavorites);
  const load = useApp((s) => s.loadIncognitoFavorites);
  const forget = useApp((s) => s.forgetIncognitoFavorites);
  const open = useIncognitoPage("incognito-more-favorites", load, forget);
  const t = useT();
  if (!open) return null;

  return (
    <Screen
      title={t("favorites.moreLocked")}
      closeLabel={t("common.back")}
      onClose={closeSheet}
      back
    >
      <FavoritesEditor
        favorites={favorites}
        folders={folders}
        save={save}
        recipeSheet="incognito-recipes"
        part="more"
      />
    </Screen>
  );
}
