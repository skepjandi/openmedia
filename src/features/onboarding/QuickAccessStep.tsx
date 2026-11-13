import { useDeferredValue, useMemo, useState } from "react";
import { useT } from "../../i18n/useT";
import { FilterIcon } from "../../shared/icons";
import { useIconForUrl } from "../../shared/siteIcons";
import { SiteTile } from "../../shared/SiteTile";
import { FilterDialog } from "../library/FilterDialog";
import type { LibraryTag, OnboardingOption } from "../library/ipc";
import { activeTags, indexItems, toggleTag, visibleIndexed } from "../library/logic";
import { TAG_LABELS } from "../library/tagLabels";
import { field, quietButton } from "../settings/ui";

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

  return (
    <OptionList
      options={options.options}
      selected={selected}
      limit={limit}
      isPro={isPro}
      onToggle={onToggle}
    />
  );
}

/** Every official recipe is already for this device and not added, so only these kinds can narrow. */
const GUIDE_FILTER_KINDS = ["discover", "type", "category"] as const;

function OptionList({
  options,
  selected,
  limit,
  isPro,
  onToggle,
}: Omit<Props, "options" | "onRetry"> & { options: OnboardingOption[] }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ReadonlySet<LibraryTag>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const index = useMemo(() => indexItems(options), [options]);
  const deferredQuery = useDeferredValue(query);
  const shown = useMemo(
    () => visibleIndexed(index, filter, deferredQuery),
    [index, filter, deferredQuery],
  );
  const active = activeTags(filter);
  const onToggleTag = (tag: LibraryTag) => setFilter((current) => toggleTag(current, tag));
  const full = selected.length >= limit;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-paper/65" aria-live="polite">
        {t("onboarding.quickCount", { count: selected.length, limit })}
        {full && !isPro && ` ${t("onboarding.quickProHint")}`}
      </p>
      <div className="flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("library.search")}
          placeholder={t("library.search")}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={field}
        />
        <button
          type="button"
          onClick={() => setFiltersOpen(true)}
          aria-haspopup="dialog"
          className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3.5 text-sm font-medium ${
            active.length > 0 ? "border-accent text-accent" : "border-hair text-paper/80"
          }`}
        >
          <FilterIcon />
          {t("library.filterButton")}
          {active.length > 0 && (
            <span className="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-xs font-semibold text-on-accent">
              {active.length}
            </span>
          )}
        </button>
      </div>
      {active.length > 0 && (
        <div role="group" aria-label={t("library.filters")} className="flex flex-wrap gap-2">
          {active.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-label={t("library.removeFilter", { name: t(TAG_LABELS[tag]) })}
              onClick={() => onToggleTag(tag)}
              className="shrink-0 rounded-full border border-accent bg-accent/15 px-3 py-1 text-sm font-medium text-accent"
            >
              {t(TAG_LABELS[tag])} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      {filtersOpen && (
        <FilterDialog
          index={index}
          filter={filter}
          query={deferredQuery}
          kinds={GUIDE_FILTER_KINDS}
          onToggleTag={onToggleTag}
          onClear={() => setFilter(new Set())}
          onClose={() => setFiltersOpen(false)}
        />
      )}
      {shown.length === 0 ? (
        <p className="text-sm text-paper/55">
          {t(deferredQuery.trim() ? "library.searchNone" : "library.noMatch")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-hair overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
          {shown.map(({ item }) => (
            <OptionRow
              key={item.recipeId}
              option={item}
              checked={selected.includes(item.recipeId)}
              disabled={full && !selected.includes(item.recipeId)}
              onToggle={() => onToggle(item.recipeId)}
            />
          ))}
        </ul>
      )}
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
