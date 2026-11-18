import { useT } from "../../i18n/useT";
import { FolderIcon, ProIcon } from "../../shared/icons";
import type { Favorite } from "../../shared/ipc";
import { useBackHandler } from "../back/useBackHandler";

/** One favorite in a folder, with what the dial knows about it. */
export interface FolderMember {
  favorite: Favorite;
  /** Its place in the favorites list. */
  index: number;
  /** Needs Pro; a tap opens the plans. */
  locked: boolean;
  /** A site of it is open. */
  live: boolean;
  /** New activity in it, from its page title; 0 when none. */
  unread: number;
}

/**
 * The favorites in one folder, opened by tapping the folder on the dial. Tapping outside, Back or
 * Escape closes it.
 */
export function FolderPopup({
  name,
  members,
  onPick,
  onClose,
}: {
  name: string;
  members: FolderMember[];
  onPick: (member: FolderMember) => void;
  onClose: () => void;
}) {
  const t = useT();
  useBackHandler(true, onClose);

  return (
    <>
      <div data-hit="" onPointerDown={onClose} className="fixed inset-0 z-[60] bg-black/45" />
      <div
        data-hit=""
        role="dialog"
        aria-label={t("favorites.folderOpen", { name })}
        className="glass assistant-dock fixed top-1/2 left-1/2 z-[61] max-h-[70vh] w-[min(88vw,22rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl p-4 text-paper"
      >
        <div className="mb-3 flex items-center gap-2 px-1 text-sm font-medium text-paper/70">
          <FolderIcon size={18} />
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </div>
        <div className="grid grid-cols-3 gap-x-2 gap-y-4">
          {members.map((member) => (
            <button
              key={member.favorite.id}
              type="button"
              aria-label={
                member.locked
                  ? t("paywall.title")
                  : t("fab.openFavorite", { name: member.favorite.name })
              }
              onClick={() => onPick(member)}
              className="flex min-w-0 flex-col items-center gap-1.5 rounded-2xl px-1 py-2 active:bg-paper/[0.08]"
            >
              <span
                className={`relative grid size-14 place-items-center rounded-2xl bg-accent/15 text-lg font-semibold text-accent uppercase ${
                  member.locked ? "grayscale" : ""
                }`}
              >
                {member.favorite.icon ? (
                  <img
                    src={member.favorite.icon}
                    alt=""
                    draggable={false}
                    className="size-9 rounded-lg"
                  />
                ) : (
                  member.favorite.name.trim().charAt(0) || "·"
                )}
                {member.locked && (
                  <span className="pro-badge absolute -end-1.5 -top-1.5 grid size-5 place-items-center rounded-full">
                    <ProIcon size={12} />
                  </span>
                )}
                {member.unread > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -end-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full border-2 border-ink bg-accent px-1 text-[10px] leading-none font-semibold text-white"
                  >
                    {member.unread > 99 ? "99+" : member.unread}
                  </span>
                )}
                {member.live && (
                  <span
                    aria-hidden="true"
                    className="absolute -bottom-1.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-accent"
                  />
                )}
              </span>
              <span
                className={`w-full truncate text-center text-[12px] ${member.locked ? "opacity-60" : ""}`}
              >
                {member.favorite.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
