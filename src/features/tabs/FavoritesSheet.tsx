import { selectQuickFavorites, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { Screen } from "../../shared/Screen";
import { FavoriteRows } from "./FavoriteRows";

/**
 * Every favorite of the set in use (the incognito one while incognito), opened from the Tabs
 * page, which shows only the first few. Favorites filed in a folder sit under it. Without Pro
 * the entries past the fourth are locked, as they are in the quick-access menu.
 */
export function FavoritesSheet() {
  const open = useApp((s) => s.sheet === "favorites");
  const openSheet = useApp((s) => s.openSheet);
  const favorites = useApp(selectQuickFavorites);
  const t = useT();

  if (!open) return null;

  return (
    <Screen
      title={t("favorites.title")}
      closeLabel={t("common.back")}
      onClose={() => openSheet("tabs")}
      back
    >
      <FavoriteRows favorites={favorites} shown={favorites.map((_, index) => index)} />
    </Screen>
  );
}
