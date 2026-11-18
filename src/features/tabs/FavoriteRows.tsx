import { useState } from "react";
import { selectQuickFolders, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import {
  FREE_QUICK_ACCESS_LIMIT,
  displayHost,
  folderIcon,
  folderKey,
  groupByFolder,
} from "../../shared/favorites";
import { DownIcon, ProIcon, UpIcon } from "../../shared/icons";
import type { Favorite } from "../../shared/ipc";
import { FolderTile } from "../../shared/FolderTile";
import { SiteTile } from "../../shared/SiteTile";
import { useEntitlementStore } from "../paywall/store";
import { Group } from "../settings/ui";
import { sessionForFavorite } from "../web/sessions";

/**
 * The favorites at `shown` (indexes into `favorites`) as rows, with the ones filed in a folder
 * collected under it. A folder opens in place and holds every favorite filed in it. Without Pro
 * the favorites past the fourth are locked, as they are in the quick-access menu.
 */
export function FavoriteRows({
  favorites,
  shown,
}: {
  favorites: readonly Favorite[];
  shown: readonly number[];
}) {
  const sessions = useApp((s) => s.sessions);
  const sites = useApp((s) => s.sites);
  const folders = useApp(selectQuickFolders);
  const openFavorite = useApp((s) => s.openFavorite);
  const openSheet = useApp((s) => s.openSheet);
  const isPro = useEntitlementStore((s) => s.status === "pro");
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const t = useT();

  const isLive = (favorite: Favorite) =>
    sessionForFavorite([...sessions], favorite.url, sites) !== undefined;
  const row = (favorite: Favorite, index: number) =>
    !isPro && index >= FREE_QUICK_ACCESS_LIMIT ? (
      <LockedRow key={favorite.id} favorite={favorite} onOpen={() => openSheet("paywall")} />
    ) : (
      <QuickRow
        key={favorite.id}
        favorite={favorite}
        live={isLive(favorite)}
        onOpen={() => openFavorite(favorite)}
      />
    );

  return (
    <Group>
      {groupByFolder(favorites, shown).map((entry) => {
        if (entry.kind === "favorite") return row(entry.favorite, entry.index);
        const key = folderKey(entry.name) ?? entry.name;
        const expanded = opened.has(key);
        const live = entry.members.some((member) => isLive(member.favorite));
        return (
          <div key={`folder:${key}`}>
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={t("favorites.folderOpen", { name: entry.name })}
              onClick={() =>
                setOpened((current) => {
                  const next = new Set(current);
                  if (!next.delete(key)) next.add(key);
                  return next;
                })
              }
              className="flex w-full items-center gap-3 px-4 py-3 text-start active:bg-paper/[0.06]"
            >
              <FolderTile
                icon={folderIcon(folders, entry.name)}
                members={entry.members.map((member) => member.favorite)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-medium">{entry.name}</span>
                <span className="block truncate text-sm text-paper/55">
                  {entry.members.map((member) => member.favorite.name).join(", ")}
                </span>
              </span>
              <span className={`shrink-0 text-sm ${live ? "text-accent" : "text-paper/40"}`}>
                {entry.members.length}
              </span>
              <span aria-hidden="true" className="shrink-0 text-paper/45">
                {expanded ? <UpIcon /> : <DownIcon />}
              </span>
            </button>
            {expanded && (
              <div className="border-t border-hair bg-paper/[0.03] ps-4">
                {entry.members.map((member) => row(member.favorite, member.index))}
              </div>
            )}
          </div>
        );
      })}
    </Group>
  );
}

export function QuickRow({
  favorite,
  live,
  onOpen,
}: {
  favorite: Favorite;
  live: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-start active:bg-paper/[0.06]"
    >
      <SiteTile name={favorite.name} icon={favorite.icon} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium">{favorite.name}</span>
        <span className="block truncate text-sm text-paper/55">{displayHost(favorite.url)}</span>
      </span>
      <span className={`shrink-0 text-sm ${live ? "text-accent" : "text-paper/40"}`}>
        {live ? t("tabs.isOpen") : t("tabs.notOpen")}
      </span>
    </button>
  );
}

function LockedRow({ favorite, onOpen }: { favorite: Favorite; onOpen: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      aria-label={t("paywall.title")}
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-start opacity-60 active:bg-paper/[0.06]"
    >
      <SiteTile name={favorite.name} icon={favorite.icon} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium">{favorite.name}</span>
        <span className="block truncate text-sm text-paper/55">{displayHost(favorite.url)}</span>
      </span>
      <ProIcon size={14} />
    </button>
  );
}
