import { useState } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import {
  FOLDER_ICONS,
  asInput,
  deleteFolder,
  folderChoices,
  folderKey,
  saveFolder,
} from "../../shared/favorites";
import { FolderTile } from "../../shared/FolderTile";
import { PlusIcon } from "../../shared/icons";
import type { Favorite, FavoriteInput, Folder } from "../../shared/ipc";
import { Screen } from "../../shared/Screen";
import { MAX_FAVORITE_NAME } from "./presets";
import { useIncognitoPage } from "./IncognitoSections";
import { Group, dangerButton, field, primaryButton, quietButton } from "./ui";

/** The folders of the normal favorites: create, rename, give an icon, delete. */
export function FoldersScreen() {
  const open = useApp((s) => s.sheet === "folders");
  const closeSheet = useApp((s) => s.closeSheet);
  const favorites = useApp((s) => s.state?.favorites) ?? [];
  const folders = useApp((s) => s.state?.folders) ?? [];
  const save = useApp((s) => s.saveFolders);
  const t = useT();
  if (!open) return null;

  return (
    <Screen title={t("folders.title")} closeLabel={t("common.back")} onClose={closeSheet} back>
      <FolderManager favorites={favorites} folders={folders} save={save} />
    </Screen>
  );
}

/** The same page for the incognito set, loaded on open and forgotten on close. */
export function IncognitoFoldersScreen() {
  const closeSheet = useApp((s) => s.closeSheet);
  const favorites = useApp((s) => s.incognito.favorites);
  const folders = useApp((s) => s.incognito.folders);
  const save = useApp((s) => s.saveIncognitoFolders);
  const load = useApp((s) => s.loadIncognitoFavorites);
  const forget = useApp((s) => s.forgetIncognitoFavorites);
  const open = useIncognitoPage("incognito-folders", load, forget);
  const t = useT();
  if (!open) return null;

  return (
    <Screen title={t("folders.title")} closeLabel={t("common.back")} onClose={closeSheet} back>
      <FolderManager favorites={favorites} folders={folders} save={save} />
    </Screen>
  );
}

interface ManagerProps {
  favorites: readonly Favorite[];
  folders: readonly Folder[];
  /** Saves the folders, and the favorites when they changed too; resolves true when saved. */
  save: (folders: Folder[], favorites?: FavoriteInput[]) => Promise<boolean>;
}

function FolderManager({ favorites, folders, save }: ManagerProps) {
  const problem = useApp((s) => s.error);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const t = useT();
  const listed = folderChoices(favorites, folders);
  const membersOf = (name: string) =>
    favorites.filter((favorite) => folderKey(favorite.folder) === folderKey(name));

  const commit = async (from: string | null, name: string, icon: string | undefined) => {
    const next = saveFolder(favorites.map(asInput), listed, from, name, icon);
    if (!next) return false;
    const renamed = from !== null && folderKey(from) !== folderKey(name);
    const saved = await save(next.folders, renamed ? next.favorites : undefined);
    if (saved) setEditing(null);
    return saved;
  };

  const remove = async (name: string) => {
    const next = deleteFolder(favorites.map(asInput), listed, name);
    if (await save(next.folders, next.favorites)) setEditing(null);
  };

  return (
    <div className="flex flex-col gap-4">
      {listed.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-hair px-4 py-5 text-sm text-paper/55">
          {t("folders.empty")}
        </p>
      ) : (
        <Group>
          {listed.map((folder) => {
            const members = membersOf(folder.name);
            const expanded = editing !== null && folderKey(editing) === folderKey(folder.name);
            return (
              <div key={folder.name}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={t("folders.edit", { name: folder.name })}
                  onClick={() => setEditing(expanded ? null : folder.name)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-start active:bg-paper/[0.06]"
                >
                  <FolderTile icon={folder.icon} members={members} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium">{folder.name}</span>
                    <span className="block truncate text-sm text-paper/55">
                      {members.length === 0
                        ? t("folders.emptyFolder")
                        : members.map((member) => member.name).join(", ")}
                    </span>
                  </span>
                </button>
                {expanded && (
                  <FolderEditor
                    key={folder.name}
                    initial={folder}
                    members={members}
                    taken={(name) =>
                      saveFolder(favorites.map(asInput), listed, folder.name, name, undefined) ===
                        null && name.trim() !== ""
                    }
                    onCommit={(name, icon) => commit(folder.name, name, icon)}
                    onDelete={() => remove(folder.name)}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </div>
            );
          })}
        </Group>
      )}

      <div>
        <button
          type="button"
          aria-expanded={editing === "new"}
          onClick={() => setEditing(editing === "new" ? null : "new")}
          className="flex items-center gap-2 px-1 py-1 text-sm font-medium text-accent"
        >
          <PlusIcon /> {t("folders.new")}
        </button>
        {editing === "new" && (
          <div className="mt-3 overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
            <FolderEditor
              initial={{ name: "" }}
              members={[]}
              taken={(name) =>
                saveFolder(favorites.map(asInput), listed, null, name, undefined) === null &&
                name.trim() !== ""
              }
              onCommit={(name, icon) => commit(null, name, icon)}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
      </div>

      {problem && <p className="px-1 text-sm text-accent">{problem}</p>}
    </div>
  );
}

interface EditorProps {
  initial: Folder;
  members: readonly Favorite[];
  /** True when another folder already has this name. */
  taken: (name: string) => boolean;
  onCommit: (name: string, icon: string | undefined) => Promise<boolean>;
  /** Absent for a folder being created. */
  onDelete?: () => void;
  onCancel: () => void;
}

function FolderEditor({ initial, members, taken, onCommit, onDelete, onCancel }: EditorProps) {
  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState<string | undefined>(initial.icon);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const t = useT();

  const done = async () => {
    if (taken(name)) {
      setProblem(t("folders.nameTaken"));
      return;
    }
    await onCommit(name, icon);
  };

  const choice = (selected: boolean) =>
    `grid size-11 place-items-center rounded-xl border text-xl leading-none ${
      selected ? "border-accent bg-accent/15" : "border-hair bg-paper/[0.04]"
    }`;

  return (
    <div className="flex flex-col gap-3 border-t border-hair bg-paper/[0.03] px-4 py-3.5">
      <input
        aria-label={t("folders.nameLabel")}
        className={field}
        maxLength={MAX_FAVORITE_NAME}
        placeholder={t("folders.nameLabel")}
        value={name}
        onChange={(event) => {
          setProblem(null);
          setName(event.target.value);
        }}
      />
      <div className="text-sm font-medium">{t("folders.iconLabel")}</div>
      <div role="radiogroup" aria-label={t("folders.iconLabel")} className="flex flex-wrap gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={icon === undefined}
          aria-label={t("folders.iconAuto")}
          title={t("folders.iconAuto")}
          onClick={() => setIcon(undefined)}
          className={choice(icon === undefined)}
        >
          <FolderTile members={members} />
        </button>
        {FOLDER_ICONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            role="radio"
            aria-checked={icon === emoji}
            aria-label={emoji}
            onClick={() => setIcon(emoji)}
            className={choice(icon === emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      <p className="text-sm leading-snug text-paper/55">{t("folders.iconAuto")}</p>
      {problem && <p className="text-sm text-accent">{problem}</p>}
      {confirming && <p className="text-sm text-paper/70">{t("folders.deleteNote")}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          className={primaryButton}
          disabled={name.trim() === ""}
          onClick={() => void done()}
        >
          {t("common.save")}
        </button>
        <button type="button" className={quietButton} onClick={onCancel}>
          {t("common.cancel")}
        </button>
        {onDelete &&
          (confirming ? (
            <button type="button" className={`${dangerButton} ms-auto`} onClick={onDelete}>
              {t("common.delete")}
            </button>
          ) : (
            <button
              type="button"
              className={`${quietButton} ms-auto`}
              onClick={() => setConfirming(true)}
            >
              {t("common.delete")}
            </button>
          ))}
      </div>
    </div>
  );
}
