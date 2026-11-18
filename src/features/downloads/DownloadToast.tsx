import { useEffect } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { useDownloadsStore } from "./store";

const SHOW_MS = 5000;

/** Says when a download finished or failed, and opens the list on a tap. */
export function DownloadToast() {
  const announcement = useDownloadsStore((s) => s.announcement);
  const dismiss = useDownloadsStore((s) => s.dismissAnnouncement);
  const sheet = useApp((s) => s.sheet);
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();

  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(dismiss, SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [announcement, dismiss]);

  if (!announcement || sheet === "downloads") return null;

  return (
    <button
      type="button"
      data-hit=""
      role="status"
      onClick={() => {
        dismiss();
        openSheet("downloads");
      }}
      className="glass fixed inset-x-3 top-[calc(var(--safe-top,0px)+12px)] z-[85] flex items-center gap-3 rounded-2xl px-4 py-3 text-start text-sm text-paper"
    >
      <span className="min-w-0 flex-1 truncate">
        {t(announcement.failed ? "downloads.announceFailed" : "downloads.announceDone", {
          name: announcement.fileName,
        })}
      </span>
      <span className="shrink-0 font-medium text-accent">{t("downloads.view")}</span>
    </button>
  );
}
