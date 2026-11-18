interface SegmentedProps<V extends string> {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
}

/** A row of exclusive choices that all show at once; use `Picker` for a longer list. */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<V>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex gap-1 rounded-2xl border border-hair bg-paper/[0.04] p-1"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`min-w-0 flex-1 rounded-xl px-2 py-2.5 text-sm font-medium desktop:py-2 ${
            value === option.value
              ? "bg-accent text-on-accent"
              : "text-paper/75 hover:bg-paper/[0.06]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
