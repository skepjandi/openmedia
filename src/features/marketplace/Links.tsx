import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { ForwardIcon } from "../../shared/icons";
import type { SiteSettings } from "../../shared/ipc";
import { Group } from "../settings/ui";
import { marketplace, sharing } from "./ipc";

/** Whether this build has a marketplace address and keys. */
export function useMarketplaceAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    void marketplace
      .status()
      .then((status) => setAvailable(status.available))
      .catch(() => setAvailable(false));
  }, []);

  return available;
}

/** The rows in Settings that open the Marketplace (when this build has one) and Import and export. */
export function MarketplaceLinks() {
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();
  const available = useMarketplaceAvailable();

  return (
    <Group>
      {available && (
        <LinkRow
          title={t("market.title")}
          note={t("market.linkNote")}
          onClick={() => openSheet("marketplace")}
        />
      )}
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

/** Shown on a recipe that came from a pasted bundle or the marketplace: says so, and removes it. */
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
