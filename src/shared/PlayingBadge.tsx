import { SpeakerIcon } from "./icons";

/**
 * A small speaker on the top corner of a site's icon: the site is playing sound or video. Give it
 * a `label` where nothing around it already says so; without one it is hidden from screen readers.
 */
export function PlayingBadge({ label }: { label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      className="pointer-events-none absolute -start-1 -top-1 grid size-[18px] place-items-center rounded-full border-2 border-ink bg-accent text-white"
    >
      <SpeakerIcon size={10} />
    </span>
  );
}
