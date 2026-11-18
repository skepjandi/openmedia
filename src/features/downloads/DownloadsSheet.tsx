import { useEffect, useState } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { Screen } from "../../shared/Screen";
import { Segmented } from "../settings/Segmented";
import { AddTab } from "./AddTab";
import { FilesTab } from "./FilesTab";
import { PageTab } from "./PageTab";
import { SettingsTab } from "./SettingsTab";
import { refresh, useDownloadsStore } from "./store";

type Tab = "files" | "page" | "add" | "settings";

/** The downloads page: the list, the media on the page in front, links to add, and the settings. */
export function DownloadsSheet() {
  const open = useApp((s) => s.sheet === "downloads");
  const parent = useApp((s) => s.sheetParent);
  const closeSheet = useApp((s) => s.closeSheet);
  const active = useDownloadsStore((s) => s.active);
  const markSeen = useDownloadsStore((s) => s.markSeen);
  const [tab, setTab] = useState<Tab>("files");
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    markSeen();
    void refresh().catch(() => undefined);
  }, [open, markSeen]);

  if (!open) return null;

  const added = () => {
    setError(null);
    setTab("files");
  };
  const fail = (message: string) => setError(message);

  return (
    <Screen
      title={t("downloads.title")}
      subtitle={active > 0 ? t("downloads.activeCount", { count: active }) : undefined}
      closeLabel={t(parent === "settings" ? "common.back" : "downloads.close")}
      onClose={closeSheet}
      back={parent === "settings"}
    >
      <div className="flex flex-col gap-5">
        <Segmented
          label={t("downloads.title")}
          value={tab}
          options={[
            { value: "files", label: t("downloads.tabList") },
            { value: "page", label: t("downloads.tabPage") },
            { value: "add", label: t("downloads.tabAdd") },
            { value: "settings", label: t("downloads.tabSettings") },
          ]}
          onChange={(next) => {
            setError(null);
            setTab(next);
          }}
        />
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {tab === "files" && <FilesTab onError={fail} />}
        {tab === "page" && <PageTab onAdded={added} onError={fail} />}
        {tab === "add" && <AddTab onAdded={added} onError={fail} />}
        {tab === "settings" && <SettingsTab onError={fail} />}
      </div>
    </Screen>
  );
}
