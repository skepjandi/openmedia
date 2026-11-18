import { FolderIcon } from "./icons";

interface FolderTileProps {
  /** The emoji the user chose; without one the tile shows what is in the folder. */
  icon?: string;
  /** The favorites in the folder, for the tile that has no icon of its own. */
  members: readonly { name: string; icon?: string }[];
}

/** A folder's tile: its chosen icon, else the icons of the first favorites in it, else a folder. */
export function FolderTile({ icon, members }: FolderTileProps) {
  const frame =
    "grid size-10 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-accent/15 text-accent";
  if (icon) {
    return (
      <span aria-hidden="true" className={`${frame} text-xl leading-none`}>
        {icon}
      </span>
    );
  }
  if (members.length === 0) {
    return (
      <span aria-hidden="true" className={frame}>
        <FolderIcon />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={frame}>
      <span className="grid grid-cols-2 gap-0.5">
        {members.slice(0, 4).map((member, index) =>
          member.icon ? (
            <img
              key={index}
              src={member.icon}
              alt=""
              draggable={false}
              className="size-[17px] rounded-[4px] object-cover"
            />
          ) : (
            <span
              key={index}
              className="grid size-[17px] place-items-center rounded-[4px] bg-accent/25 text-[10px] leading-none font-semibold uppercase"
            >
              {member.name.trim().charAt(0) || "?"}
            </span>
          ),
        )}
      </span>
    </span>
  );
}
