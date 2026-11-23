import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { displayHost } from "../../shared/favorites";
import type { Favorite } from "../../shared/ipc";
import { useIconForUrl } from "../../shared/siteIcons";
import { SiteTile } from "../../shared/SiteTile";
import { Group, Section, quietButton } from "./ui";

const NO_FAVORITES: Favorite[] = [];

/**
 * The fan's bookmark slot: the page it holds, and buttons to put the visible page there or empty
 * it. One slot, free for everyone; nothing can be saved while incognito.
 */
export function BookmarkSection() {
  const bookmark = useApp((s) => s.state?.bookmark ?? null);
  const favorites = useApp((s) => s.state?.favorites) ?? NO_FAVORITES;
  const canSave = useApp((s) => s.activeId !== null && !s.incognito.active);
  const saveBookmark = useApp((s) => s.saveBookmark);
  const removeBookmark = useApp((s) => s.removeBookmark);
  const icon = useIconForUrl(bookmark?.url ?? "", favorites);
  const t = useT();

  return (
    <Section title={t("bookmark.title")} note={t("bookmark.note")}>
      <Group>
        <div className="flex items-center gap-3 px-4 py-3.5">
          {bookmark && <SiteTile name={displayHost(bookmark.url)} icon={icon} />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-base">{bookmark?.title ?? t("bookmark.empty")}</div>
            {bookmark && (
              <div className="truncate text-sm text-paper/55">{displayHost(bookmark.url)}</div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 px-4 py-3">
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void saveBookmark()}
            className={quietButton}
          >
            {bookmark ? t("bookmark.replace") : t("bookmark.save")}
          </button>
          {bookmark && (
            <button type="button" onClick={() => void removeBookmark()} className={quietButton}>
              {t("common.remove")}
            </button>
          )}
        </div>
      </Group>
    </Section>
  );
}
