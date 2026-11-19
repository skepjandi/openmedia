import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useT } from "../../i18n/useT";
import { Glyph, isGlyph } from "../../shared/glyphs";
import { FolderIcon } from "../../shared/icons";
import { PlayingBadge } from "../../shared/PlayingBadge";
import type { Favorite } from "../../shared/ipc";
import { useBackHandler } from "../back/useBackHandler";
import { CARRY_HOLD_MS, carryHold, strayedFromPress, type CarryHold } from "./gesture";

/** How far a held favorite moves before it is a drag out of the popup. */
const CARRY_SLOP = 12;

/** One favorite in a folder, with what the dial knows about it. */
export interface FolderMember {
  favorite: Favorite;
  /** Its place in the favorites list. */
  index: number;
  /** A site of it is open. */
  live: boolean;
  /** New activity in it, from its page title; 0 when none. */
  unread: number;
  /** A site of it is playing sound or video. */
  playing: boolean;
}

/**
 * The favorites in one folder, opened by tapping the folder on the dial. Tapping outside, Back or
 * Escape closes it.
 */
export function FolderPopup({
  name,
  icon,
  members,
  onPick,
  onClose,
  onCarry,
  onOpenAll,
}: {
  name: string;
  /** The icon the user gave the folder, if any. */
  icon?: string;
  members: FolderMember[];
  onPick: (member: FolderMember) => void;
  onClose: () => void;
  /** A favorite was dragged out of the popup (desktop): it goes with the pointer. */
  onCarry?: (member: FolderMember, event: PointerEvent<HTMLButtonElement>) => void;
  /** Opens every favorite in the folder side by side, in the folder's layout (desktop). */
  onOpenAll?: () => void;
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
          {isGlyph(icon) ? <Glyph name={icon} size={18} /> : <FolderIcon size={18} />}
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {onOpenAll && members.length > 1 && (
            <button
              type="button"
              onClick={onOpenAll}
              className="shrink-0 rounded-full border border-hair px-3 py-1 text-xs font-medium text-paper/85"
            >
              {t("tile.openFolder")}
            </button>
          )}
        </div>
        <div className="grid grid-cols-3 gap-x-2 gap-y-4">
          {members.map((member) => (
            <MemberButton
              key={member.favorite.id}
              member={member}
              onPick={onPick}
              onCarry={onCarry}
            />
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * One favorite of the popup. On desktop a press that is held lifts the tile, and only then does
 * moving on drag the favorite out; a press that moves before that is not a drag.
 */
function MemberButton({
  member,
  onPick,
  onCarry,
}: {
  member: FolderMember;
  onPick: (member: FolderMember) => void;
  onCarry?: (member: FolderMember, event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const press = useRef<{ x: number; y: number; at: number; strayed: boolean } | null>(null);
  const armTimer = useRef(0);
  const [hold, setHold] = useState<CarryHold>("idle");
  const t = useT();
  useEffect(() => () => clearTimeout(armTimer.current), []);

  const endPress = () => {
    clearTimeout(armTimer.current);
    press.current = null;
    setHold("idle");
  };

  return (
    <button
      type="button"
      aria-label={t("fab.openFavorite", { name: member.favorite.name })}
      onPointerDown={(event) => {
        if (!onCarry) return;
        press.current = { x: event.clientX, y: event.clientY, at: Date.now(), strayed: false };
        setHold(carryHold(0, false));
        clearTimeout(armTimer.current);
        armTimer.current = window.setTimeout(() => {
          const current = press.current;
          if (current && !current.strayed) setHold("armed");
        }, CARRY_HOLD_MS);
      }}
      onPointerMove={(event) => {
        const from = press.current;
        if (!onCarry || !from) return;
        const moved = Math.hypot(event.clientX - from.x, event.clientY - from.y);
        const held = carryHold(Date.now() - from.at, from.strayed);
        if (held === "charging" && strayedFromPress(moved)) {
          from.strayed = true;
          clearTimeout(armTimer.current);
          setHold("idle");
        } else if (held === "armed" && moved > CARRY_SLOP) {
          endPress();
          onCarry(member, event);
        }
      }}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onPointerCancel={endPress}
      onClick={() => onPick(member)}
      className="flex min-w-0 flex-col items-center gap-1.5 rounded-2xl px-1 py-2 active:bg-paper/[0.08]"
    >
      <span
        data-carry={hold === "idle" ? undefined : hold}
        className="carry-tile relative grid size-14 place-items-center rounded-2xl bg-accent/15 text-lg font-semibold text-accent uppercase"
      >
        {member.favorite.icon ? (
          <img src={member.favorite.icon} alt="" draggable={false} className="size-9 rounded-lg" />
        ) : (
          member.favorite.name.trim().charAt(0) || "·"
        )}
        {member.playing && <PlayingBadge />}
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
        {onCarry && (
          <svg className="fab-ring" viewBox="0 0 64 64" aria-hidden="true">
            <circle cx="32" cy="32" r="31" pathLength="1" />
          </svg>
        )}
      </span>
      <span className="w-full truncate text-center text-[12px]">{member.favorite.name}</span>
    </button>
  );
}
