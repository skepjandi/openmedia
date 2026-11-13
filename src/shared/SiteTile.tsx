interface SiteTileProps {
  name: string;
  icon?: string;
}

/** The site's own icon when it is known, else its first letter on a tinted square. */
export function SiteTile({ name, icon }: SiteTileProps) {
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-10 shrink-0 rounded-[10px] object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-accent/15 text-base font-semibold text-accent uppercase"
    >
      {name.trim().charAt(0) || "?"}
    </span>
  );
}
