import { useState } from "react";
import { selectPage, useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { DesktopIcon, SearchIcon, ShareIcon, TrashIcon } from "../../shared/icons";
import { pageTools } from "../../shared/ipc";
import { siteOf } from "../../shared/site";
import { useFind } from "../find/findStore";

const tool =
  "flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs text-paper/80 active:bg-paper/[0.08] disabled:opacity-30";

/** The page's own actions that a browser's menu has: find, share, desktop site, clear site data. */
export function PageTools({ onDone }: { onDone: () => void }) {
  const t = useT();
  const page = useApp(selectPage);
  const isDesktopApp = useApp((s) => s.desktop);
  const desktopSites = useApp((s) => s.state?.desktopSites ?? []);
  const setSiteDesktop = useApp((s) => s.setSiteDesktop);
  const openFind = useFind((s) => s.openBar);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const url = page?.url ?? null;
  const web = url !== null && /^https?:\/\//i.test(url);
  const site = web ? siteOf(url) : null;
  const desktopOn = site !== null && desktopSites.includes(site);
  const fail = (error: unknown) => setNotice(describeError(error, t));

  const share = () => {
    if (!web) return;
    setConfirming(false);
    if (!isDesktopApp) {
      pageTools.share(url, page?.title ?? null).catch(fail);
      return;
    }
    navigator.clipboard
      .writeText(url)
      .then(() => setNotice(t("pageTools.linkCopied")))
      .catch(fail);
  };

  const clear = () => {
    if (!site) return;
    setConfirming(false);
    pageTools
      .clearSiteData(site)
      .then(() => {
        setNotice(null);
        onDone();
      })
      .catch(fail);
  };

  return (
    <div className="mt-2 border-t border-hair pt-1">
      <div className="flex">
        <button
          type="button"
          disabled={!web}
          className={tool}
          onClick={() => {
            openFind();
            onDone();
          }}
        >
          <SearchIcon />
          <span className="max-w-full truncate">{t("pageTools.find")}</span>
        </button>
        <button type="button" disabled={!web} className={tool} onClick={share}>
          <ShareIcon />
          <span className="max-w-full truncate">
            {t(isDesktopApp ? "pageTools.copyLink" : "pageTools.share")}
          </span>
        </button>
        {!isDesktopApp && (
          <button
            type="button"
            aria-pressed={desktopOn}
            disabled={!site}
            className={`${tool} ${desktopOn ? "text-accent" : ""}`}
            onClick={() => {
              if (site) void setSiteDesktop(site, !desktopOn);
              setConfirming(false);
              onDone();
            }}
          >
            <DesktopIcon on={desktopOn} />
            <span className="max-w-full truncate">{t("pageTools.desktopSite")}</span>
          </button>
        )}
        <button
          type="button"
          disabled={!site}
          aria-expanded={confirming}
          className={`${tool} ${confirming ? "text-warning" : ""}`}
          onClick={() => setConfirming((now) => !now)}
        >
          <TrashIcon />
          <span className="max-w-full truncate">{t("pageTools.clearData")}</span>
        </button>
      </div>
      {confirming && site && (
        <div role="alert" className="mt-1 rounded-xl bg-paper/[0.05] px-3 py-2">
          <p className="text-xs leading-snug text-paper/80">
            {t("pageTools.clearDataConfirm", { site })}
          </p>
          <div className="mt-2 flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-full px-3 py-1.5 text-sm text-paper/70 active:bg-paper/[0.08]"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={clear}
              className="rounded-full px-3 py-1.5 text-sm font-medium text-warning active:bg-paper/[0.08]"
            >
              {t("pageTools.clearDataAction")}
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="px-2 pt-1 text-xs leading-snug text-paper/60">
          {notice}
        </p>
      )}
    </div>
  );
}
