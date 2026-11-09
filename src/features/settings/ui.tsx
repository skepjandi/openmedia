import { useEffect, useState, type ReactNode } from "react";
import { BiometricIcon } from "../../shared/icons";

export const field =
  "w-full min-w-0 rounded-xl border border-hair bg-paper/[0.05] px-3 py-2.5 text-base text-paper outline-none placeholder:text-paper/35 focus:border-accent";

export const primaryButton =
  "rounded-full bg-accent px-5 py-2 text-sm font-semibold text-on-accent disabled:opacity-40";

export const quietButton =
  "rounded-full border border-hair px-4 py-2 text-sm font-medium text-paper/85 disabled:opacity-40";

interface SectionProps {
  title: string;
  /** Explains the group below it, in small print. */
  note?: ReactNode;
  /** Sections start open; a long one can start collapsed. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/** A titled block of settings. The title is small and quiet; the controls carry the weight. */
export function Section({ title, note, defaultOpen = true, children }: SectionProps) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between px-1 py-2 text-sm font-semibold text-paper">
        <span>{title}</span>
        <span aria-hidden="true" className="text-paper/45 group-open:rotate-180">
          ⌄
        </span>
      </summary>
      <div className="pt-3">
        {children}
        {note && <p className="px-1 pt-2.5 text-[13px] leading-snug text-paper/50">{note}</p>}
      </div>
    </details>
  );
}

/** One rounded card whose rows are separated by hairlines. */
export function Group({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-hair overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
      {children}
    </div>
  );
}

interface LockedSectionProps {
  title: string;
  /** Explains the group below it, in small print, once it is open. */
  note?: ReactNode;
  /** Says under the title why nothing shows yet. */
  lockedHint: string;
  /** Asks for the biometric check; true when it passed. */
  unlock: () => Promise<boolean>;
  /** Loads what the section shows, after the check passed and before it opens. */
  onUnlocked: () => Promise<void>;
  /** Drops what was loaded. Must be stable: it also runs when the app leaves the foreground. */
  onLocked: () => void;
  children: ReactNode;
}

/**
 * A section that starts collapsed and opens only after a biometric check. Closing it, leaving
 * Settings or sending the app to the background locks it again, so the next look asks again.
 */
export function LockedSection({
  title,
  note,
  lockedHint,
  unlock,
  onUnlocked,
  onLocked,
  children,
}: LockedSectionProps) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const lockWhenHidden = () => {
      if (!document.hidden) return;
      setOpen(false);
      onLocked();
    };
    document.addEventListener("visibilitychange", lockWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", lockWhenHidden);
      onLocked();
    };
  }, [onLocked]);

  const toggle = async () => {
    if (checking) return;
    if (open) {
      setOpen(false);
      onLocked();
      return;
    }
    setChecking(true);
    const passed = await unlock();
    if (passed) await onUnlocked();
    setChecking(false);
    setOpen(passed);
  };

  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        aria-busy={checking}
        disabled={checking}
        onClick={() => void toggle()}
        className="flex w-full cursor-pointer items-center justify-between px-1 py-2 text-start text-sm font-semibold text-paper disabled:opacity-60"
      >
        <span className="flex items-center gap-2">
          {!open && <BiometricIcon />}
          {title}
        </span>
        <span aria-hidden="true" className={`text-paper/45 ${open ? "rotate-180" : ""}`}>
          ⌄
        </span>
      </button>
      {open ? (
        <div className="pt-3">
          {children}
          {note && <p className="px-1 pt-2.5 text-[13px] leading-snug text-paper/50">{note}</p>}
        </div>
      ) : (
        <p className="px-1 text-[13px] leading-snug text-paper/50">{lockedHint}</p>
      )}
    </section>
  );
}

/** A small label above a group, for blocks inside a section. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return <h3 className="px-1 pt-1 pb-2 text-[13px] font-medium text-paper/60">{children}</h3>;
}
