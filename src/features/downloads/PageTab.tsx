import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { downloads, type SniffedPage } from "../../shared/ipc";
import { field, primaryBlockButton, quietButton } from "../settings/ui";
import {
  compilePattern,
  countByKind,
  filterMedia,
  KIND_FILTERS,
  type KindFilter,
} from "./sniffFilter";

/** The links, images, video and audio on the page in front, to pick from. */
export function PageTab({
  onAdded,
  onError,
}: {
  onAdded: () => void;
  onError: (message: string) => void;
}) {
  const desktop = useApp((s) => s.desktop);
  const [found, setFound] = useState<SniffedPage | null>(null);
  const [scanning, setScanning] = useState(!desktop);
  const [kind, setKind] = useState<KindFilter>("all");
  const [pattern, setPattern] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const t = useT();

  const load = useCallback(
    () =>
      downloads
        .sniff()
        .then(
          (result) => {
            setFound(result);
            setPicked(new Set());
          },
          (error: unknown) => onError(String(error)),
        )
        .finally(() => setScanning(false)),
    [onError],
  );

  useEffect(() => {
    if (!desktop) void load();
  }, [desktop, load]);

  const scan = () => {
    setScanning(true);
    void load();
  };

  const items = useMemo(() => found?.items ?? [], [found]);
  const shown = useMemo(() => filterMedia(items, kind, pattern), [items, kind, pattern]);
  const counts = useMemo(() => countByKind(items), [items]);
  const invalid = compilePattern(pattern) === "invalid";
  const chosen = shown.filter((item) => picked.has(item.url));

  if (desktop) return <p className="text-sm text-paper/60">{t("downloads.sniffDesktop")}</p>;

  const toggle = (url: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(url)) next.add(url);
      return next;
    });

  const start = () => {
    downloads
      .add(
        chosen.map((item) => ({
          url: item.url,
          label: item.label || undefined,
          kind: item.kind,
          pageUrl: found?.page.url || undefined,
          pageTitle: found?.page.title || undefined,
        })),
      )
      .then(onAdded, (error: unknown) => onError(String(error)));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-paper/60">{t("downloads.sniffNote")}</p>
      <div
        className="flex flex-wrap gap-1.5"
        role="radiogroup"
        aria-label={t("downloads.sniffTitle")}
      >
        {KIND_FILTERS.filter((entry) => entry === "all" || counts[entry] > 0).map((entry) => (
          <button
            key={entry}
            type="button"
            role="radio"
            aria-checked={kind === entry}
            onClick={() => setKind(entry)}
            className={`rounded-full border px-3 py-1 text-sm ${
              kind === entry
                ? "border-accent bg-accent text-on-accent"
                : "border-hair text-paper/75"
            }`}
          >
            {t(entry === "all" ? "downloads.filterAll" : `downloads.kind.${entry}`)} {counts[entry]}
          </button>
        ))}
      </div>
      <input
        value={pattern}
        onChange={(event) => setPattern(event.target.value)}
        placeholder={t("downloads.filterText")}
        aria-label={t("downloads.filterText")}
        aria-invalid={invalid}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className={`${field} font-mono text-sm`}
      />
      {invalid && <p className="text-sm text-danger">{t("downloads.badPattern")}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={quietButton} disabled={scanning} onClick={scan}>
          {t(found ? "downloads.sniffRescan" : "downloads.sniffScan")}
        </button>
        <button
          type="button"
          className={quietButton}
          disabled={shown.length === 0}
          onClick={() => setPicked(new Set(shown.map((item) => item.url)))}
        >
          {t("downloads.selectAll")}
        </button>
        <button
          type="button"
          className={quietButton}
          disabled={picked.size === 0}
          onClick={() => setPicked(new Set())}
        >
          {t("downloads.selectNone")}
        </button>
      </div>
      {found && shown.length === 0 && (
        <p className="py-6 text-center text-sm text-paper/55">{t("downloads.sniffEmpty")}</p>
      )}
      <ul className="divide-y divide-hair overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
        {shown.map((item) => (
          <li key={`${item.kind}:${item.url}`}>
            <label className="flex items-center gap-3 px-4 py-2.5 active:bg-paper/[0.05]">
              <input
                type="checkbox"
                checked={picked.has(item.url)}
                onChange={() => toggle(item.url)}
                className="size-5 shrink-0 accent-[var(--color-accent)]"
              />
              <span className="shrink-0 rounded-md border border-hair px-1.5 py-0.5 text-[10px] font-medium text-paper/60 uppercase">
                {t(`downloads.kind.${item.kind}`)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{item.label || item.url}</span>
                <span className="block truncate text-xs text-paper/45">
                  {item.width > 0 && item.height > 0 ? `${item.width}×${item.height} · ` : ""}
                  {item.url}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={chosen.length === 0}
        onClick={start}
        className={primaryBlockButton}
      >
        {t("downloads.downloadSelected", { count: chosen.length })}
      </button>
    </div>
  );
}
