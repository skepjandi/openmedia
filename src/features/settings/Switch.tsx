interface SwitchProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Greys the row and ignores taps, for a setting that depends on another one. */
  disabled?: boolean;
}

/** A full-width row with a label on the left and a switch on the right; sits inside a `Group`. */
export function Switch({ label, description, checked, onChange, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-between gap-4 px-4 py-3.5 text-start hover:bg-paper/[0.04] active:bg-paper/[0.05] desktop:py-3 ${
        disabled ? "opacity-40" : ""
      }`}
    >
      <span className="min-w-0">
        <span className="block text-base desktop:text-[15px]">{label}</span>
        {description && (
          <span className="mt-0.5 block text-sm leading-snug text-paper/55 desktop:text-[13px]">
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors desktop:h-6 desktop:w-10 ${
          checked ? "bg-accent" : "bg-paper/20"
        }`}
      >
        <span
          className={`absolute top-0.5 size-6 rounded-full transition-all desktop:size-5 ${
            checked ? "start-[22px] bg-on-accent desktop:start-[18px]" : "start-0.5 bg-paper/70"
          }`}
        />
      </span>
    </button>
  );
}
