import { useEffect, useRef, useState } from "react";
import { useApp } from "../../app/store";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import { useIconForUrl } from "../../shared/siteIcons";
import { isFavoriteSite, toggleSiteFavorite } from "../../shared/favorites";
import { tabHost } from "../../shared/hubs";
import { DownIcon, ForwardIcon, StarIcon } from "../../shared/icons";
import { isActive, isChoiceOption } from "../../shared/options";
import type { Hub, OptionGroup, OptionValue, SiteSettings } from "../../shared/ipc";
import { SiteTile } from "../../shared/SiteTile";
import { Screen } from "../../shared/Screen";
import { GuideLink } from "../guides/GuideLink";
import { ChoiceRow } from "./ChoiceRow";
import { Switch } from "./Switch";
import { ImportedNotice } from "../library/Links";
import { ProtectOptions } from "./ProtectOptions";
import { RecipeDetails } from "./RecipeDetails";
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
  const hidden = sites.reduce((sum, site) => sum + site.options.filter(isActive).length, 0);

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
  const t = useT();
  if (!open) return null;

  return (
    <Screen title={t("recipes.title")} closeLabel={t("common.back")} onClose={closeSheet} back>
      <div className="mb-6 rounded-2xl border border-hair bg-paper/[0.04] p-4">
        <p className="text-sm leading-relaxed text-paper/65">{t("recipes.note")}</p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          <GuideLink slug="your-recipe" labelKey="guides.makeRecipe" />
          <GuideLink slug="change-a-site" labelKey="guides.customizeSite" />
        </div>
      </div>
      {sites.length === 0 && (
        <div className="flex flex-col items-start gap-3 px-1">
          <p className="text-sm text-paper/70">{t("recipes.empty")}</p>
          <button type="button" onClick={() => openSheet("library")} className={quietButton}>
            {t("recipes.openLibrary")}
          </button>
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
  const focused = useApp((s) => !incognito && s.recipeFocus === site.recipeId);
  const [open, setOpen] = useState(focused);
  const card = useRef<HTMLDivElement>(null);
  const favorites = useApp((s) => s.state?.favorites);
  const setSiteFavorite = useApp((s) => s.setSiteFavorite);
  const icon = useIconForUrl(site.homepage ?? "", favorites ?? []);
  const hidden = site.options.filter(isActive).length;
  const incognitoFavorites = useApp((s) => s.incognito.favorites);
  const saveIncognitoFavorites = useApp((s) => s.saveIncognitoFavorites);
  const t = useT();
  useEffect(() => {
    if (focused) card.current?.scrollIntoView({ block: "start" });
  }, [focused]);
  const starred = incognito
    ? isFavoriteSite(incognitoFavorites, site.homepage ?? "")
    : site.favorite;
  const toggleFavorite = () => {
    if (!incognito) void setSiteFavorite(site.recipeId, !site.favorite);
    else if (site.homepage)
      void saveIncognitoFavorites(toggleSiteFavorite(incognitoFavorites, site.homepage));
  };

  return (
    <div ref={card} className="overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
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
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-base font-medium">{site.name}</span>
              {site.hub && (
                <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                  {t("recipes.hub")}
                </span>
              )}
            </span>
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
  const openHubTab = useApp((s) => s.openHubTab);

  return (
    <div className="flex flex-col gap-5 border-t border-hair px-3 py-4">
      <ImportedNotice site={site} />
      {site.hub && site.hub.tabs.length > 0 && (
        <HubPages hub={site.hub} onOpen={(url) => openHubTab(url, site.recipeId)} />
      )}
      <OptionGroups
        site={site}
        onChange={(optionId, value) => void setSiteOption(site.recipeId, optionId, value)}
      />
      <ProtectOptions site={site} />
      <RecipeDetails site={site} />
    </div>
  );
}

/** The pages of a hub. Each one is a site of its own and opens as an ordinary page. */
function HubPages({ hub, onOpen }: { hub: Hub; onOpen: (url: string) => void }) {
  const t = useT();

  return (
    <div>
      <GroupLabel>{t("recipes.hubPages")}</GroupLabel>
      <Group>
        {hub.tabs.map((tab) => (
          <button
            key={tab.url}
            type="button"
            aria-label={t("recipes.openHubPage", { label: tab.label })}
            onClick={() => onOpen(tab.url)}
            className="flex w-full items-center gap-3 px-4 py-3 text-start active:bg-paper/[0.05]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base">{tab.label}</span>
              <span className="block truncate text-sm text-paper/55">{tabHost(tab)}</span>
            </span>
            <span aria-hidden="true" className="text-paper/50 rtl:-scale-x-100">
              <ForwardIcon />
            </span>
          </button>
        ))}
      </Group>
      <p className="px-1 pt-2 text-[13px] leading-snug text-paper/50">{t("recipes.hubNote")}</p>
    </div>
  );
}

function IncognitoSiteOptions({ site }: { site: SiteSettings }) {
  const setIncognitoSiteOption = useApp((s) => s.setIncognitoSiteOption);
  const openHubTab = useApp((s) => s.openHubTab);

  return (
    <div className="flex flex-col gap-5 border-t border-hair px-3 py-4">
      <ImportedNotice site={site} incognito />
      {site.hub && site.hub.tabs.length > 0 && (
        <HubPages hub={site.hub} onOpen={(url) => openHubTab(url, site.recipeId)} />
      )}
      <OptionGroups
        site={site}
        onChange={(optionId, value) => void setIncognitoSiteOption(site.recipeId, optionId, value)}
      />
      <RecipeDetails site={site} />
    </div>
  );
}

/** The site's settings, annoyances first and then content: a switch or a row of states each. */
function OptionGroups({
  site,
  onChange,
}: {
  site: SiteSettings;
  onChange: (optionId: string, value: OptionValue) => void;
}) {
  const t = useT();

  return GROUPS.map(({ group, title }) => {
    const options = site.options.filter((option) => option.group === group);
    if (options.length === 0) return null;
    return (
      <div key={group}>
        <GroupLabel>{t(title)}</GroupLabel>
        <Group>
          {options.map((option) =>
            isChoiceOption(option) ? (
              <ChoiceRow
                key={option.id}
                label={option.label}
                description={option.description}
                choices={option.choices}
                value={String(option.value)}
                onChange={(choice) => onChange(option.id, choice)}
              />
            ) : (
              <Switch
                key={option.id}
                label={option.label}
                description={option.description}
                checked={option.value === true}
                onChange={(enabled) => onChange(option.id, enabled)}
              />
            ),
          )}
        </Group>
      </div>
    );
  });
}
