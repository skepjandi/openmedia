import { useState } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import {
  FREE_QUICK_ACCESS_LIMIT,
  QUICK_ACCESS_LIMIT,
  asInput,
  recipeForFavorite,
} from "../../shared/favorites";
import { DownIcon, ForwardIcon, ProIcon, PlusIcon, StarIcon, UpIcon } from "../../shared/icons";
import type { Favorite, FavoriteInput, SiteSettings } from "../../shared/ipc";
import { SiteTile } from "../../shared/SiteTile";
import { normalizeWebUrl } from "../../shared/url";
import { useEntitlementStore } from "../paywall/store";
import { describeAddress } from "../history/address";
import { MAX_FAVORITE_NAME } from "./presets";
import { Switch } from "./Switch";
import { Group, GroupLabel, Section, field, primaryButton, quietButton } from "./ui";

/**
 * The favorites list is as long as the user likes; the first few are the quick-access menu that
 * fans out from the floating button. Every change saves at once, so the list in Settings never
 * disagrees with the one a recipe's star edits.
 */
export function FavoritesSection() {
  const favorites = useApp((s) => s.state?.favorites) ?? [];
  const saveFavorites = useApp((s) => s.saveFavorites);
  const sites = useApp((s) => s.sites);
  const t = useT();

  return (
    <Section title={t("favorites.title")} note={t("favorites.note", { limit: QUICK_ACCESS_LIMIT })}>
      <FavoritesEditor
        favorites={favorites}
        save={saveFavorites}
        recipes={sites}
        recipeSheet="recipes"
      />
    </Section>
  );
}

interface EditorListProps {
  favorites: Favorite[];
  /** Replaces the whole list; resolves true when it was saved. */
  save: (favorites: FavoriteInput[]) => Promise<boolean>;
  /** Shown when quick access is empty; the default points at starring a recipe. */
  emptyText?: string;
  /** The installed recipes; a favorite whose site has one gets a button that opens it. */
  recipes?: SiteSettings[];
  /** Opens the matching recipe list so its stars update this favorites list. */
  recipeSheet: "recipes" | "incognito-recipes";
}

/**
 * The quick-access group, the rest, and the add button, for whichever list it is given. Without
 * Pro only four slots are usable: the other two show grayed out, More favorites is locked, and
 * adding past four opens the paywall.
 */
export function FavoritesEditor({
  favorites,
  save,
  emptyText,
  recipes,
  recipeSheet,
}: EditorListProps) {
  const problem = useApp((s) => s.error);
  const openSheet = useApp((s) => s.openSheet);
  const openRecipe = useApp((s) => s.openRecipe);
  const isPro = useEntitlementStore((s) => s.status === "pro");
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const t = useT();

  const limit = isPro ? QUICK_ACCESS_LIMIT : FREE_QUICK_ACCESS_LIMIT;
  const quick = favorites.slice(0, limit);
  const lockedSlots = isPro
    ? []
    : Array.from(
        { length: QUICK_ACCESS_LIMIT - FREE_QUICK_ACCESS_LIMIT },
        (_, i) => favorites[limit + i] ?? null,
      );
  const more = favorites.slice(QUICK_ACCESS_LIMIT);

  const replaceAll = (next: FavoriteInput[]) => {
    setEditing(null);
    return save(next);
  };

  const move = (index: number, by: -1 | 1) => {
    const next = favorites.map(asInput);
    [next[index], next[index + by]] = [next[index + by], next[index]];
    void replaceAll(next);
  };

  const commit = (index: number | "new", entry: FavoriteInput) => {
    const next = favorites.map(asInput);
    if (index === "new") next.push(entry);
    else next[index] = entry;
    return replaceAll(next);
  };

  const remove = (index: number) => {
    void replaceAll(favorites.map(asInput).filter((_, at) => at !== index));
  };

  const renderRow = (favorite: Favorite, index: number) => {
    const recipe = recipes && recipeForFavorite(recipes, favorite.url);
    return (
      <FavoriteRow
        key={favorite.id}
        favorite={favorite}
        first={index === 0}
        last={index === favorites.length - 1}
        editing={editing === index}
        showNotify={index < limit}
        onEdit={() => setEditing(editing === index ? null : index)}
        onMove={(by) => move(index, by)}
        onCommit={(entry) => commit(index, entry)}
        onRemove={() => remove(index)}
        onOpenRecipe={recipe ? () => openRecipe(recipe.recipeId) : undefined}
      />
    );
  };

  return (
    <>
      <GroupLabel>{t("favorites.quickAccess", { count: quick.length, limit })}</GroupLabel>
      {quick.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-hair px-4 py-5 text-sm text-paper/55">
          {emptyText ?? t("favorites.quickEmpty")}
        </p>
      ) : (
        <Group>{quick.map((favorite, index) => renderRow(favorite, index))}</Group>
      )}
      {lockedSlots.length > 0 && (
        <div className="mt-2">
          <Group>
            {lockedSlots.map((favorite, index) => (
              <LockedFavoriteRow
                key={favorite?.id ?? `locked-${index}`}
                favorite={favorite}
                onOpen={() => openSheet("paywall")}
              />
            ))}
          </Group>
        </div>
      )}

      {isPro ? (
        more.length > 0 && (
          <details className="group/more mt-5">
            <summary className="flex cursor-pointer list-none items-center justify-between px-1 pt-1 pb-2 text-[13px] font-medium text-paper/60">
              <span>{t("favorites.more", { count: more.length })}</span>
              <span aria-hidden="true" className="text-paper/45 group-open/more:rotate-180">
                ⌄
              </span>
            </summary>
            <Group>
              {more.map((favorite, index) => renderRow(favorite, index + QUICK_ACCESS_LIMIT))}
            </Group>
          </details>
        )
      ) : (
        <button
          type="button"
          onClick={() => openSheet("paywall")}
          className="mt-5 flex w-full items-center justify-between px-1 pt-1 pb-2 text-start text-[13px] font-medium text-paper/60"
        >
          <span className="flex items-center gap-2">
            <ProIcon size={14} />
            {t("favorites.moreLocked")}
          </span>
          <span aria-hidden="true" className="text-paper/45">
            ⌄
          </span>
        </button>
      )}

      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            aria-expanded={editing === "new"}
            onClick={() =>
              !isPro && favorites.length >= limit
                ? openSheet("paywall")
                : setEditing(editing === "new" ? null : "new")
            }
            className="flex items-center gap-2 px-1 py-1 text-sm font-medium text-accent"
          >
            <PlusIcon /> {t("favorites.custom")}
            {!isPro && favorites.length >= limit && <ProIcon size={14} />}
          </button>
          <button
            type="button"
            onClick={() => openSheet(recipeSheet)}
            className="flex items-center gap-2 px-1 py-1 text-sm font-medium text-accent"
          >
            <span aria-hidden="true" className="rtl:-scale-x-100">
              <ForwardIcon />
            </span>
            {t("favorites.addFromRecipes")}
          </button>
        </div>
        {editing === "new" && (
          <div className="mt-3 overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
            <FavoriteEditor
              initial={{ name: "", url: "" }}
              showNotify={favorites.length < limit}
              hint={favorites.length >= limit ? t("favorites.quickFull") : undefined}
              onCommit={(entry) => commit("new", entry)}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
      </div>

      {problem && <p className="mt-3 px-1 text-sm text-accent">{problem}</p>}
    </>
  );
}

/** A quick-access slot that needs Pro: grayed out, and a tap opens the plans. */
function LockedFavoriteRow({
  favorite,
  onOpen,
}: {
  favorite: Favorite | null;
  onOpen: () => void;
}) {
  const t = useT();
  const host = favorite ? describeAddress(favorite.url).host : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 py-2.5 pe-4 ps-4 text-start active:bg-paper/[0.05]"
    >
      <span className="flex min-w-0 flex-1 items-center gap-3 opacity-45 grayscale">
        {favorite ? (
          <SiteTile name={favorite.name} icon={favorite.icon} />
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-paper/[0.08]">
            <ProIcon size={16} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium">
            {favorite ? favorite.name : t("paywall.title")}
          </span>
          {host && <span className="block truncate text-sm text-paper/55">{host}</span>}
        </span>
      </span>
      <span className="pro-badge grid size-6 shrink-0 place-items-center rounded-full">
        <ProIcon size={12} />
      </span>
    </button>
  );
}

interface RowProps {
  favorite: Favorite;
  first: boolean;
  last: boolean;
  editing: boolean;
  /** Only a quick-access favorite can notify, so only its editor offers the switch. */
  showNotify: boolean;
  onEdit: () => void;
  onMove: (by: -1 | 1) => void;
  onCommit: (entry: FavoriteInput) => Promise<boolean>;
  onRemove: () => void;
  /** Present when the favorite's site has an installed recipe. */
  onOpenRecipe?: () => void;
}

function FavoriteRow({
  favorite,
  first,
  last,
  editing,
  showNotify,
  onEdit,
  onMove,
  onCommit,
  onRemove,
  onOpenRecipe,
}: RowProps) {
  const { host } = describeAddress(favorite.url);
  const arrow = "grid size-10 place-items-center text-paper/65 disabled:opacity-20";
  const t = useT();

  return (
    <div>
      <div className="flex items-center pe-1">
        <button
          type="button"
          aria-expanded={editing}
          aria-label={t("favorites.edit", { name: favorite.name })}
          onClick={onEdit}
          className="flex min-w-0 flex-1 items-center gap-3 py-2.5 ps-4 text-start"
        >
          <SiteTile name={favorite.name} icon={favorite.icon} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-medium">{favorite.name}</span>
            <span className="block truncate text-sm text-paper/55">{host}</span>
          </span>
        </button>
        <button
          type="button"
          aria-pressed
          aria-label={t("recipes.removeFavorite", { name: favorite.name })}
          onClick={onRemove}
          className="grid size-10 place-items-center text-accent"
        >
          <StarIcon filled />
        </button>
        <button
          type="button"
          aria-label={t("favorites.moveUp", { name: favorite.name })}
          disabled={first}
          onClick={() => onMove(-1)}
          className={arrow}
        >
          <UpIcon />
        </button>
        <button
          type="button"
          aria-label={t("favorites.moveDown", { name: favorite.name })}
          disabled={last}
          onClick={() => onMove(1)}
          className={arrow}
        >
          <DownIcon />
        </button>
      </div>
      {editing && (
        <FavoriteEditor
          initial={{ name: favorite.name, url: favorite.url, notify: favorite.notify }}
          showNotify={showNotify}
          onCommit={onCommit}
          onCancel={onEdit}
          onRemove={onRemove}
          onOpenRecipe={onOpenRecipe}
        />
      )}
    </div>
  );
}

interface EditorProps {
  initial: FavoriteInput;
  showNotify: boolean;
  hint?: string;
  onCommit: (entry: FavoriteInput) => Promise<boolean>;
  onCancel: () => void;
  onRemove?: () => void;
  onOpenRecipe?: () => void;
}

function FavoriteEditor({
  initial,
  showNotify,
  hint,
  onCommit,
  onCancel,
  onRemove,
  onOpenRecipe,
}: EditorProps) {
  const [name, setName] = useState(initial.name);
  const [url, setUrl] = useState(initial.url);
  const [notify, setNotify] = useState(initial.notify ?? true);
  const [problem, setProblem] = useState<string | null>(null);
  const t = useT();

  const done = async () => {
    const address = normalizeWebUrl(url);
    if (!name.trim() || !address) {
      setProblem(t("favorites.invalid"));
      return;
    }
    await onCommit({ name: name.trim(), url: address, notify });
  };

  return (
    <div className="flex flex-col gap-2.5 border-t border-hair bg-paper/[0.03] px-4 py-3.5">
      <input
        aria-label={t("favorites.nameLabel")}
        className={field}
        maxLength={MAX_FAVORITE_NAME}
        placeholder={t("favorites.namePlaceholder")}
        value={name}
        onChange={(event) => {
          setProblem(null);
          setName(event.target.value);
        }}
      />
      <input
        aria-label={t("favorites.addressLabel")}
        className={field}
        autoCapitalize="none"
        autoCorrect="off"
        inputMode="url"
        placeholder={t("favorites.addressPlaceholder")}
        value={url}
        onChange={(event) => {
          setProblem(null);
          setUrl(event.target.value);
        }}
      />
      {showNotify && (
        <div className="-mx-4">
          <Switch label={t("favorites.notify")} checked={notify} onChange={setNotify} />
        </div>
      )}
      {(problem ?? hint) && (
        <p className={`text-sm ${problem ? "text-accent" : "text-paper/55"}`}>{problem ?? hint}</p>
      )}
      {onOpenRecipe && (
        <button type="button" onClick={onOpenRecipe} className={`self-start ${quietButton}`}>
          {t("favorites.openRecipe")}
        </button>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void done()} className={primaryButton}>
          {t("common.save")}
        </button>
        <button type="button" onClick={onCancel} className={quietButton}>
          {t("common.cancel")}
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className={`${quietButton} ms-auto text-red-400`}
          >
            {t("common.remove")}
          </button>
        )}
      </div>
    </div>
  );
}
