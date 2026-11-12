import { useT } from "../../i18n/useT";
import { useIconForUrl } from "../../shared/siteIcons";
import { SiteTile } from "../../shared/SiteTile";
import { quietButton } from "../settings/ui";
import type { OnboardingOption } from "../library/ipc";

export type OptionsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; options: OnboardingOption[] };

interface Props {
  options: OptionsState;
  selected: readonly string[];
  limit: number;
  isPro: boolean;
  onToggle: (recipeId: string) => void;
  onRetry: () => void;
}

/** The official recipes for this device as checkbox rows. Everything here can be skipped. */
export function QuickAccessStep({ options, selected, limit, isPro, onToggle, onRetry }: Props) {
  const t = useT();

  if (options.status === "loading") {
    return <p className="text-sm text-paper/55">{t("onboarding.quickLoading")}</p>;
  }
  if (options.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-paper/70">{options.message}</p>
        <button type="button" onClick={onRetry} className={quietButton}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (options.options.length === 0) {
    return <p className="text-sm text-paper/55">{t("onboarding.quickEmpty")}</p>;
  }

  const full = selected.length >= limit;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-paper/65" aria-live="polite">
        {t("onboarding.quickCount", { count: selected.length, limit })}
        {full && !isPro && ` ${t("onboarding.quickProHint")}`}
      </p>
      <ul className="flex flex-col divide-y divide-hair overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
        {options.options.map((option) => (
          <OptionRow
            key={option.recipeId}
            option={option}
            checked={selected.includes(option.recipeId)}
            disabled={full && !selected.includes(option.recipeId)}
            onToggle={() => onToggle(option.recipeId)}
          />
        ))}
      </ul>
    </div>
  );
}

function OptionRow({
  option,
  checked,
  disabled,
  onToggle,
}: {
  option: OnboardingOption;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const icon = useIconForUrl(option.homepage, []);

  return (
    <li>
      <label
        className={`flex items-center gap-3 px-4 py-3 active:bg-paper/[0.05] ${
          disabled ? "opacity-50" : ""
        }`}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="size-5 shrink-0 accent-[var(--color-accent)]"
        />
        <SiteTile name={option.name} icon={icon} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium">{option.name}</span>
          <span className="block truncate text-sm text-paper/55">{option.summary}</span>
        </span>
      </label>
    </li>
  );
}
