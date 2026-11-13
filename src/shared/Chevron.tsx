import { DownIcon } from "./icons";

/** The disclosure arrow: points down when closed and turns up as the row opens. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`shrink-0 text-paper/45 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
    >
      <DownIcon />
    </span>
  );
}
