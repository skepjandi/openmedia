import type { OptionChoice } from "../../shared/ipc";

interface ChoiceRowProps {
  label: string;
  description?: string;
  choices: readonly OptionChoice[];
  value: string;
  onChange: (choiceId: string) => void;
}

/** A setting with several states: its name and note above a row of the states; sits in a `Group`. */
export function ChoiceRow({ label, description, choices, value, onChange }: ChoiceRowProps) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <span className="min-w-0">
        <span className="block text-base">{label}</span>
        {description && (
          <span className="mt-0.5 block text-sm leading-snug text-paper/55">{description}</span>
        )}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex gap-1 rounded-2xl border border-hair bg-paper/[0.04] p-1"
      >
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={value === choice.id}
            onClick={() => onChange(choice.id)}
            className={`min-w-0 flex-1 truncate rounded-xl px-2 py-2 text-sm font-medium ${
              value === choice.id ? "bg-accent text-on-accent" : "text-paper/75"
            }`}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
