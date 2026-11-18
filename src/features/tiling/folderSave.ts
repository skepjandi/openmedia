import { favoriteName, favoriteStartUrl, folderKey } from "../../shared/favorites";
import type { FavoriteInput, Folder } from "../../shared/ipc";
import { leaves, toTiles, type Layout } from "./layout";

/**
 * The favorites and folders once the windows are saved as the folder `name`. A window whose
 * page is already a favorite of the folder keeps it; any other becomes a new favorite there, at
 * its site with the page as its landing page. The folder keeps its icon and takes the layout.
 * Null for a blank name or a window with no address.
 */
export function windowsToFolder(
  name: string,
  windows: Layout,
  openedUrl: (id: string) => string | null,
  favorites: readonly FavoriteInput[],
  folders: readonly Folder[],
): { favorites: FavoriteInput[]; folders: Folder[] } | null {
  const folder = name.trim();
  const key = folderKey(folder);
  if (key === null) return null;
  const added: FavoriteInput[] = [];
  const favoriteOf = new Map<string, string>();
  for (const id of leaves(windows)) {
    const page = openedUrl(id);
    if (page === null) return null;
    const member = [...favorites, ...added].find(
      (favorite) =>
        folderKey(favorite.folder) === key &&
        (favorite.url === page || favoriteStartUrl(favorite) === page),
    );
    if (member) {
      favoriteOf.set(id, member.url);
      continue;
    }
    const root = `${new URL(page).origin}/`;
    added.push({
      name: favoriteName(page),
      url: root,
      landing: page === root ? null : page,
      folder,
    });
    favoriteOf.set(id, root);
  }
  const layout = toTiles(windows, (id) => favoriteOf.get(id) ?? null);
  if (layout === null) return null;
  const existing = folders.find((entry) => folderKey(entry.name) === key);
  const saved: Folder = { ...existing, name: existing?.name ?? folder, layout };
  return {
    favorites: [...favorites, ...added],
    folders: existing
      ? folders.map((entry) => (entry === existing ? saved : entry))
      : [...folders, saved],
  };
}
