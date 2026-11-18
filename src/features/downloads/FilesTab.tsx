import { useState } from "react";
import { useT } from "../../i18n/useT";
import { downloads, type Download, type DownloadPreview } from "../../shared/ipc";
import { isAndroid, isIos } from "../../shared/platform";
import { quietButton } from "../settings/ui";
import { formatBytes, formatEta, formatSpeed } from "./format";
import { fraction, isActive, isFinished, newestFirst } from "./list";
import { forget, refresh, useDownloadsStore } from "./store";

const rowButton =
  "rounded-full px-3 py-1.5 text-sm font-medium text-paper/80 active:bg-paper/[0.08]";
const accentButton =
  "rounded-full px-3 py-1.5 text-sm font-medium text-accent active:bg-paper/[0.08]";

export function FilesTab({ onError }: { onError: (message: string) => void }) {
  const items = useDownloadsStore((s) => s.items);
  const t = useT();
  const list = newestFirst(items);
  const anyFinished = items.some(isFinished);

  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-8 pt-12 text-center">
        <p className="text-base font-medium">{t("downloads.empty")}</p>
        <p className="max-w-xs text-sm leading-relaxed text-paper/55">{t("downloads.emptyBody")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {anyFinished && (
        <div className="flex justify-end">
          <button
            type="button"
            className={quietButton}
            onClick={() => {
              downloads.clearFinished().then(refresh, (error: unknown) => onError(String(error)));
            }}
          >
            {t("downloads.clearFinished")}
          </button>
        </div>
      )}
      <ul className="divide-y divide-hair overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
        {list.map((download) => (
          <FileRow key={download.id} download={download} onError={onError} />
        ))}
      </ul>
    </div>
  );
}

function statusLine(download: Download, t: ReturnType<typeof useT>): string {
  const { status, received, total, speed } = download;
  if (status === "queued") return t("downloads.statusQueued");
  if (status === "failed") return download.error ?? t("downloads.statusFailed");
  if (status === "cancelled") return t("downloads.statusCancelled");
  if (status === "done") return formatBytes(total ?? received);
  const size = total ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received);
  if (status === "paused") return `${t("downloads.statusPaused")} · ${size}`;
  const eta = total ? formatEta(total - received, speed) : null;
  return [size, speed > 0 ? formatSpeed(speed) : null, eta].filter(Boolean).join(" · ");
}

function FileRow({
  download,
  onError,
}: {
  download: Download;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<DownloadPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const done = download.status === "done";
  const progress = fraction(download);
  const canReveal = !isAndroid() && !isIos();

  const run = (action: Promise<void>, after?: () => Promise<void>) => {
    action.then(after ?? (() => undefined), (error: unknown) => onError(String(error)));
  };
  const togglePreview = () => {
    if (previewing) {
      setPreviewing(false);
      return;
    }
    downloads.preview(download.id).then(
      (result) => {
        setPreview(result);
        setPreviewing(true);
      },
      (error: unknown) => onError(String(error)),
    );
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded-md border border-hair px-1.5 py-0.5 text-[10px] font-medium text-paper/60 uppercase">
          {t(`downloads.kind.${download.kind}`)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium">{download.fileName}</div>
          <div
            className={`truncate text-sm tabular-nums ${
              download.status === "failed" ? "text-danger" : "text-paper/55"
            }`}
          >
            {statusLine(download, t)}
            {download.private && ` · ${t("downloads.private")}`}
          </div>
        </div>
      </div>
      {isActive(download) && progress !== null && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="h-1.5 overflow-hidden rounded-full bg-paper/10"
        >
          <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-1">
        {isActive(download) && download.resumable && (
          <button
            type="button"
            className={rowButton}
            onClick={() => run(downloads.pause(download.id))}
          >
            {t("downloads.pause")}
          </button>
        )}
        {download.status === "paused" && (
          <button
            type="button"
            className={accentButton}
            onClick={() => run(downloads.resume(download.id))}
          >
            {t("downloads.resume")}
          </button>
        )}
        {(isActive(download) || download.status === "paused") && (
          <button
            type="button"
            className={rowButton}
            onClick={() => run(downloads.cancel(download.id))}
          >
            {t("common.cancel")}
          </button>
        )}
        {(download.status === "failed" || download.status === "cancelled") && (
          <button
            type="button"
            className={accentButton}
            onClick={() => run(downloads.resume(download.id))}
          >
            {t("downloads.retry")}
          </button>
        )}
        {done && (
          <>
            <button
              type="button"
              className={accentButton}
              onClick={() => run(downloads.open(download.id))}
            >
              {t("downloads.open")}
            </button>
            {canReveal && (
              <button
                type="button"
                className={rowButton}
                onClick={() => run(downloads.reveal(download.id))}
              >
                {t("downloads.reveal")}
              </button>
            )}
            <button type="button" className={rowButton} onClick={togglePreview}>
              {t(previewing ? "downloads.hidePreview" : "downloads.preview")}
            </button>
          </>
        )}
        {isFinished(download) && (
          <button
            type="button"
            className={rowButton}
            onClick={() =>
              run(downloads.remove(download.id), () => {
                forget(download.id);
                return Promise.resolve();
              })
            }
          >
            {t("downloads.remove")}
          </button>
        )}
      </div>
      {previewing && preview && <PreviewBody preview={preview} />}
    </li>
  );
}

function PreviewBody({ preview }: { preview: DownloadPreview }) {
  const t = useT();
  if (preview.kind === "image") {
    return (
      <img src={preview.dataUri} alt="" className="max-h-72 w-full rounded-xl object-contain" />
    );
  }
  if (preview.kind === "text") {
    return (
      <pre className="max-h-60 overflow-auto rounded-xl bg-paper/[0.06] p-3 text-xs whitespace-pre-wrap">
        {preview.text}
      </pre>
    );
  }
  return <p className="text-sm text-paper/55">{t("downloads.previewNone")}</p>;
}
