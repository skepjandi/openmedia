import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { downloads, type FoundMedia, type SniffedPage } from "../../shared/ipc";
import { Thumb } from "./Thumb";
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
          <MediaRow
            key={`${item.kind}:${item.url}`}
            item={item}
            pageUrl={found?.page.url ?? ""}
            checked={picked.has(item.url)}
            onToggle={() => toggle(item.url)}
          />
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

function MediaRow({
  item,
  pageUrl,
  checked,
  onToggle,
}: {
  item: FoundMedia;
  pageUrl: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const [picture, setPicture] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState(false);

  return (
    <li>
      <div className="flex items-center active:bg-paper/[0.05]">
        <label className="flex min-w-0 flex-1 items-center gap-3 py-2.5 ps-4">
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className="size-5 shrink-0 accent-[var(--color-accent)]"
          />
          {item.kind === "image" ? (
            <Thumb url={item.url} pageUrl={pageUrl} onLoaded={setPicture} />
          ) : (
            <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-paper/[0.06] text-[10px] font-medium text-paper/60 uppercase">
              {t(`downloads.kind.${item.kind}`)}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{item.label || item.url}</span>
            <span className="block truncate text-xs text-paper/45">
              {item.width > 0 && item.height > 0 ? `${item.width}×${item.height} · ` : ""}
              {item.url}
            </span>
          </span>
        </label>
        {picture && (
          <button
            type="button"
            onClick={() => setEnlarged(!enlarged)}
            className="shrink-0 px-4 py-2.5 text-sm font-medium text-accent"
          >
            {t(enlarged ? "downloads.hidePreview" : "downloads.preview")}
          </button>
        )}
      </div>
      {enlarged && picture && (
        <img src={picture} alt="" className="max-h-72 w-full bg-paper/[0.04] object-contain p-2" />
      )}
    </li>
  );
}
