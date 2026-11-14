import { selectQuickFavorites, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { FREE_QUICK_ACCESS_LIMIT, displayHost } from "../../shared/favorites";
import { ProIcon } from "../../shared/icons";
import { Screen } from "../../shared/Screen";
import { SiteTile } from "../../shared/SiteTile";
import { useEntitlementStore } from "../paywall/store";
import { Group } from "../settings/ui";
import { sessionForFavorite } from "../web/sessions";
import { QuickRow } from "./TabsSheet";

/**
 * Every favorite of the set in use (the incognito one while incognito), opened from the Tabs
 * page, which shows only the first few. Without Pro the entries past the fourth are locked, as
 * they are in the quick-access menu.
 */
export function FavoritesSheet() {
  const open = useApp((s) => s.sheet === "favorites");
  const openSheet = useApp((s) => s.openSheet);
  const favorites = useApp(selectQuickFavorites);
  const sessions = useApp((s) => s.sessions);
  const sites = useApp((s) => s.sites);
  const openFavorite = useApp((s) => s.openFavorite);
  const isPro = useEntitlementStore((s) => s.status === "pro");
  const t = useT();

  if (!open) return null;

  return (
    <Screen
      title={t("favorites.title")}
      closeLabel={t("common.back")}
      onClose={() => openSheet("tabs")}
      back
    >
      <Group>
        {favorites.map((favorite, index) =>
          !isPro && index >= FREE_QUICK_ACCESS_LIMIT ? (
            <button
              key={favorite.id}
              type="button"
              onClick={() => openSheet("paywall")}
              className="flex w-full items-center gap-3 px-4 py-3 text-start opacity-60 active:bg-paper/[0.06]"
            >
              <SiteTile name={favorite.name} icon={favorite.icon} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-medium">{favorite.name}</span>
                <span className="block truncate text-sm text-paper/55">
                  {displayHost(favorite.url)}
                </span>
              </span>
              <ProIcon size={14} />
            </button>
          ) : (
            <QuickRow
              key={favorite.id}
              favorite={favorite}
              live={sessionForFavorite(sessions, favorite.url, sites) !== undefined}
              onOpen={() => openFavorite(favorite.url)}
            />
          ),
        )}
      </Group>
    </Screen>
  );
}
