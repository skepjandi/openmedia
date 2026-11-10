import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { ForwardIcon } from "../../shared/icons";

const GUIDES_URL = "https://openmedia.surf/guides/";

/** The step-by-step guides on the website, one per task. */
export type GuideSlug = "connect-ai" | "change-a-site" | "your-recipe" | "marketplace";

export const guideUrl = (slug: GuideSlug): string => `${GUIDES_URL}${slug}/`;

/** A quiet link that opens a guide from the website in the page view. */
export function GuideLink({ slug }: { slug: GuideSlug }) {
  const openSearch = useApp((s) => s.openSearch);
  const t = useT();

  return (
    <button
      type="button"
      onClick={() => openSearch(guideUrl(slug))}
      className="flex items-center gap-1 px-1 py-1 text-sm font-medium text-accent"
    >
      {t("guides.read")}
      <span aria-hidden="true" className="rtl:-scale-x-100">
        <ForwardIcon />
      </span>
    </button>
  );
}
