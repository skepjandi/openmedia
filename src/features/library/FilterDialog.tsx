import { useMemo } from "react";
import { useT } from "../../i18n/useT";
import type { MessageKey } from "../../i18n/messages";
import type { LibraryTag } from "./ipc";
import { FILTER_KINDS, facetCounts, type IndexedItem, visibleIndexed } from "./logic";
import { TAG_LABELS } from "./tagLabels";

const KIND_LABELS: Record<(typeof FILTER_KINDS)[number]["id"], MessageKey> = {
  origin: "library.filterKind.origin",
  platform: "library.filterKind.platform",
  type: "library.filterKind.type",
  status: "library.filterKind.status",
  category: "library.filterKind.category",
};

interface FilterDialogProps {
  index: readonly IndexedItem[];
  filter: ReadonlySet<LibraryTag>;
  query: string;
  onToggleTag: (tag: LibraryTag) => void;
  onClear: () => void;
  onClose: () => void;
}

/** Every filter in one place: a section per kind, each chip with how many recipes it would show. */
export function FilterDialog({
  index,
  filter,
  query,
  onToggleTag,
  onClear,
  onClose,
}: FilterDialogProps) {
  const t = useT();
  const counts = useMemo(() => facetCounts(index, filter, query), [index, filter, query]);
  const shown = useMemo(() => visibleIndexed(index, filter, query).length, [index, filter, query]);

  return (
    <div
      data-hit=""
      role="dialog"
      aria-modal="true"
      aria-label={t("library.filterTitle")}
      className="fixed inset-0 z-[70] flex flex-col justify-end bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85%] flex-col rounded-t-2xl bg-ink px-5 pt-4 pb-[calc(var(--safe-bottom)+16px)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3">
          <h2 className="text-base font-semibold">{t("library.filterTitle")}</h2>
          <button
            type="button"
            onClick={onClear}
            disabled={filter.size === 0}
            className="px-2 py-1 text-sm text-accent disabled:opacity-40"
          >
            {t("library.filterClear")}
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-4">
          {FILTER_KINDS.map((kind) => (
            <section key={kind.id} aria-label={t(KIND_LABELS[kind.id])}>
              <h3 className="pb-2 text-xs tracking-[0.15em] text-paper/50 uppercase">
                {t(KIND_LABELS[kind.id])}
              </h3>
              <div className="flex flex-wrap gap-2">
                {kind.tags.map((tag) => {
                  const on = filter.has(tag);
                  const count = counts.get(tag) ?? 0;
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={on}
                      disabled={count === 0 && !on}
                      onClick={() => onToggleTag(tag)}
                      className={`rounded-full border px-3.5 py-1.5 text-sm font-medium disabled:opacity-35 ${
                        on ? "border-accent bg-accent text-on-accent" : "border-hair text-paper/75"
                      }`}
                    >
                      {t(TAG_LABELS[tag])} <span className="opacity-60">{count}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        {shown === 0 && <p className="pb-2 text-sm text-paper/55">{t("library.filterNoMatch")}</p>}
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl bg-accent px-4 py-3 text-base font-medium text-on-accent"
        >
          {t("library.filterShow")} ({shown})
        </button>
      </div>
    </div>
  );
}
