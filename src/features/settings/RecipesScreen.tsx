import { useState } from "react";
import { useApp } from "../../app/store";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import { useIconForUrl } from "../../shared/siteIcons";
import { isFavoriteSite, toggleSiteFavorite } from "../../shared/favorites";
import { DownIcon, ForwardIcon, StarIcon } from "../../shared/icons";
import type { OptionGroup, SiteSettings } from "../../shared/ipc";
import { SiteTile } from "../../shared/SiteTile";
import { Screen } from "../../shared/Screen";
import { useMarketplaceAvailable } from "../marketplace/Links";
import { MarginSlider } from "./MarginSlider";
import { Switch } from "./Switch";
import { ImportedNotice } from "../marketplace/Links";
import { Group, GroupLabel, quietButton } from "./ui";

const GROUPS: { group: OptionGroup; title: MessageKey }[] = [
  { group: "annoyance", title: "recipes.annoyances" },
  { group: "content", title: "recipes.content" },
];

/** The row in Settings that opens the Recipes page. */
export function RecipesLink() {
  const sites = useApp((s) => s.sites);
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();
  const total = sites.reduce((sum, site) => sum + site.options.length, 0);
  const hidden = sites.reduce(
    (sum, site) => sum + site.options.filter((option) => option.enabled).length,
    0,
  );

  return (
    <Group>
      <button
        type="button"
        onClick={() => openSheet("recipes")}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-paper/[0.05]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{t("recipes.title")}</span>
          {total > 0 && (
            <span className="block text-sm text-paper/55">
              {hidden === 0
                ? t("recipes.nothingHidden")
                : t("recipes.hiddenCount", { count: hidden, total })}
            </span>
          )}
        </span>
        <span aria-hidden="true" className="text-paper/50 rtl:-scale-x-100">
          <ForwardIcon />
        </span>
      </button>
    </Group>
  );
}

/** Ready-made tweaks for popular sites, on a page of their own. */
export function RecipesScreen() {
  const open = useApp((s) => s.sheet === "recipes");
  const closeSheet = useApp((s) => s.closeSheet);
  const sites = useApp((s) => s.sites);
  const openSheet = useApp((s) => s.openSheet);
  const marketAvailable = useMarketplaceAvailable();
  const t = useT();
  if (!open) return null;

  return (
    <Screen title={t("recipes.title")} closeLabel={t("common.back")} onClose={closeSheet} back>
      <p className="px-1 pb-4 text-[13px] leading-snug text-paper/50">{t("recipes.note")}</p>
      {sites.length === 0 && (
        <div className="flex flex-col items-start gap-3 px-1">
          <p className="text-sm text-paper/70">{t("recipes.empty")}</p>
          {marketAvailable && (
            <button type="button" onClick={() => openSheet("marketplace")} className={quietButton}>
              {t("recipes.openMarket")}
            </button>
          )}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {sites.map((site) => (
          <SiteCard key={site.recipeId} site={site} />
        ))}
      </div>
    </Screen>
  );
}

/** One recipe's card. In incognito mode it edits the incognito choices and favorites and has no margin. */
export function SiteCard({ site, incognito = false }: { site: SiteSettings; incognito?: boolean }) {
  const [open, setOpen] = useState(false);
  const favorites = useApp((s) => s.state?.favorites);
  const setSiteFavorite = useApp((s) => s.setSiteFavorite);
  const icon = useIconForUrl(site.homepage ?? "", favorites ?? []);
  const hidden = site.options.filter((option) => option.enabled).length;
  const incognitoFavorites = useApp((s) => s.incognito.favorites);
  const saveIncognitoFavorites = useApp((s) => s.saveIncognitoFavorites);
  const t = useT();
  const starred = incognito
    ? isFavoriteSite(incognitoFavorites, site.homepage ?? "")
    : site.favorite;
  const toggleFavorite = () => {
    if (!incognito) void setSiteFavorite(site.recipeId, !site.favorite);
    else if (site.homepage)
      void saveIncognitoFavorites(toggleSiteFavorite(incognitoFavorites, site.homepage));
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-label={t("recipes.options", { name: site.name })}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-3 py-3 pe-2 ps-4 text-start active:bg-paper/[0.05]"
        >
          <SiteTile name={site.name} icon={icon} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-medium">{site.name}</span>
            <span className="block text-sm text-paper/55">
              {hidden === 0
                ? t("recipes.nothingHidden")
                : t("recipes.hiddenCount", { count: hidden, total: site.options.length })}
            </span>
          </span>
          <span
            className={`text-paper/50 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          >
            <DownIcon />
          </span>
        </button>
        {site.homepage && (
          <button
            type="button"
            aria-pressed={starred}
            aria-label={t(starred ? "recipes.removeFavorite" : "recipes.addFavorite", {
              name: site.name,
            })}
            onClick={toggleFavorite}
            className={`grid size-12 shrink-0 place-items-center active:bg-paper/[0.05] ${
              starred ? "text-accent" : "text-paper/55"
            }`}
          >
            <StarIcon filled={starred} />
          </button>
        )}
      </div>
      {open && (incognito ? <IncognitoSiteOptions site={site} /> : <SiteOptions site={site} />)}
    </div>
  );
}

function SiteOptions({ site }: { site: SiteSettings }) {
  const setSiteOption = useApp((s) => s.setSiteOption);
  const setSiteBottomMargin = useApp((s) => s.setSiteBottomMargin);
  const sharedMargin = useApp((s) => s.state?.bottomMargin ?? 0);
  const t = useT();

  return (
    <div className="flex flex-col gap-5 border-t border-hair px-3 py-4">
      <ImportedNotice site={site} />
      <OptionGroups
        site={site}
        onToggle={(optionId, enabled) => void setSiteOption(site.recipeId, optionId, enabled)}
      />
      <div>
        <GroupLabel>{t("recipes.bottomMargin")}</GroupLabel>
        <Group>
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <p className="text-sm leading-snug text-paper/55">
              {site.bottomMargin === null ? t("recipes.sharedMargin") : t("recipes.ownMargin")}
            </p>
            <MarginSlider
              label={t("recipes.siteMarginLabel", { name: site.name })}
              value={site.bottomMargin ?? sharedMargin}
              onCommit={(pixels) => void setSiteBottomMargin(site.recipeId, pixels)}
            />
            {site.bottomMargin !== null && (
              <button
                type="button"
                onClick={() => void setSiteBottomMargin(site.recipeId, null)}
                className={`self-start ${quietButton}`}
              >
                {t("recipes.useSharedMargin")}
              </button>
            )}
          </div>
        </Group>
      </div>
    </div>
  );
}

function IncognitoSiteOptions({ site }: { site: SiteSettings }) {
  const setIncognitoSiteOption = useApp((s) => s.setIncognitoSiteOption);

  return (
    <div className="flex flex-col gap-5 border-t border-hair px-3 py-4">
      <OptionGroups
        site={site}
        onToggle={(optionId, enabled) =>
          void setIncognitoSiteOption(site.recipeId, optionId, enabled)
        }
      />
    </div>
  );
}

/** The site's switches, annoyances first and then content. */
function OptionGroups({
  site,
  onToggle,
}: {
  site: SiteSettings;
  onToggle: (optionId: string, enabled: boolean) => void;
}) {
  const t = useT();

  return GROUPS.map(({ group, title }) => {
    const options = site.options.filter((option) => option.group === group);
    if (options.length === 0) return null;
    return (
      <div key={group}>
        <GroupLabel>{t(title)}</GroupLabel>
        <Group>
          {options.map((option) => (
            <Switch
              key={option.id}
              label={option.label}
              description={option.description}
              checked={option.enabled}
              onChange={(enabled) => onToggle(option.id, enabled)}
            />
          ))}
        </Group>
      </div>
    );
  });
}
