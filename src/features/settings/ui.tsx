import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../../app/store";
import { Chevron } from "../../shared/Chevron";
import { BiometricIcon } from "../incognito/BiometricIcon";

export const field =
  "w-full min-w-0 rounded-xl border border-hair bg-paper/[0.05] px-3 py-2.5 text-base text-paper outline-none placeholder:text-paper/35 focus:border-accent";

export const primaryButton =
  "rounded-full bg-accent px-5 py-2 text-sm font-semibold text-on-accent disabled:opacity-40";

export const quietButton =
  "rounded-full border border-hair px-4 py-2 text-sm font-medium text-paper/85 disabled:opacity-40";

/** The confirming step of something that erases data: red, so it never looks like a plain "OK". */
export const dangerButton =
  "rounded-full bg-danger/15 px-5 py-2 text-sm font-semibold text-danger disabled:opacity-40";

/** Full-width, equal-height variants for button stacks at the bottom of a page. */
export const quietBlockButton = `flex min-h-11 w-full items-center justify-center gap-2 ${quietButton}`;

export const primaryBlockButton = `flex min-h-11 w-full items-center justify-center gap-2 ${primaryButton}`;

interface SectionProps {
  title: string;
  /** Explains the group below it, in small print. */
  note?: ReactNode;
  children: ReactNode;
}

/**
 * A titled block of settings. On a phone the title is a quiet label over the card and the note
 * sits under it, as in the system's own Settings; on desktop the title is a heading with its note
 * above the block. Phones get one part of Settings per page, so no block folds away.
 */
export function Section({ title, note, children }: SectionProps) {
  const desktop = useApp((s) => s.desktop);
  if (desktop) {
    return (
      <section>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {note && <p className="mt-1 max-w-prose text-sm leading-snug text-paper/55">{note}</p>}
        <div className="pt-4">{children}</div>
      </section>
    );
  }
  return (
    <section>
      <h2 className="eyebrow px-1 pb-2.5">{title}</h2>
      {children}
      {note && <p className="px-1 pt-2.5 text-[13px] leading-snug text-paper/50">{note}</p>}
    </section>
  );
}

/** One rounded card whose rows are separated by hairlines. */
export function Group({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-hair overflow-hidden rounded-2xl border border-hair bg-paper/[0.04] desktop:rounded-xl">
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
  const incognitoActive = useApp((s) => s.incognito.active);

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
        className="eyebrow flex w-full cursor-pointer items-center justify-between px-1 py-2 text-start disabled:opacity-60"
      >
        <span className="flex items-center gap-2">
          {!open && !incognitoActive && <BiometricIcon />}
          {title}
        </span>
        <Chevron open={open} />
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
