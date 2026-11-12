import { useState, type ReactNode } from "react";
import { useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { ForwardIcon } from "../../shared/icons";
import type { SiteSettings } from "../../shared/ipc";
import { Group } from "../settings/ui";
import { sharing } from "./ipc";

/** The rows in Settings that open the recipe library and Import, export and share. */
export function LibraryLinks() {
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();

  return (
    <Group>
      <LinkRow
        title={t("library.title")}
        note={t("library.linkNote")}
        onClick={() => openSheet("library")}
      />
      <LinkRow
        title={t("share.link")}
        note={t("share.linkNote")}
        onClick={() => openSheet("share")}
      />
    </Group>
  );
}

function LinkRow({ title, note, onClick }: { title: string; note: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-paper/[0.05]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium">{title}</span>
        <span className="block text-sm text-paper/55">{note}</span>
      </span>
      <span aria-hidden="true" className="text-paper/50 rtl:-scale-x-100">
        <ForwardIcon />
      </span>
    </button>
  );
}

/** Shown on a recipe that came from a pasted bundle: says so, and removes it. */
export function ImportedNotice({
  site,
  incognito = false,
}: {
  site: SiteSettings;
  incognito?: boolean;
}): ReactNode {
  const loadSites = useApp((s) => s.loadSites);
  const loadIncognitoSites = useApp((s) => s.loadIncognitoSites);
  const t = useT();
  const [error, setError] = useState<string | null>(null);

  if (site.origin !== "imported") return null;

  const remove = async () => {
    try {
      await sharing.removeImported(site.recipeId);
      await loadSites();
      if (incognito) await loadIncognitoSites();
    } catch (failure) {
      setError(describeError(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-hair px-4 py-3">
      <p className="text-sm leading-snug text-paper/55">{t("recipes.imported")}</p>
      {error && <p className="text-sm text-paper/70">{error}</p>}
      <button
        type="button"
        onClick={() => void remove()}
        className="self-start text-sm font-medium text-accent"
      >
        {t("common.remove")}
      </button>
    </div>
  );
}
