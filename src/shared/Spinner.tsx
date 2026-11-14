import type { ReactNode } from "react";

/**
 * The app's one loading ring: an accent arc over a faint track. It always spins: it is the only
 * sign that work is in progress, and a still ring reads as a hang.
 */
export function Spinner({
  label,
  size = 20,
  className = "",
}: {
  /** Text beside the ring. It is announced when the ring appears. */
  label?: ReactNode;
  /** The ring's diameter, in pixels. */
  size?: number;
  className?: string;
}) {
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-3 text-sm text-paper/55 ${className}`}
    >
      <span
        aria-hidden="true"
        style={{ width: size, height: size }}
        className="shrink-0 animate-spin rounded-full border-2 border-paper/15 border-t-accent"
      />
      {label}
    </span>
  );
}
