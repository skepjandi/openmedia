import { appError, useApp } from "../../app/store";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import { ForwardIcon } from "../../shared/icons";
import { library } from "../../shared/ipc";

const GUIDES_URL = "https://openmedia.surf/guides/";

/** The step-by-step guides on the website, one per task. */
export type GuideSlug = "connect-ai" | "change-a-site" | "your-recipe";

export const guideUrl = (slug: GuideSlug): string => `${GUIDES_URL}${slug}/`;

/** A quiet link that opens a guide from the website in the system browser, never in a page view. */
export function GuideLink({
  slug,
  labelKey = "guides.read",
}: {
  slug: GuideSlug;
  labelKey?: MessageKey;
}) {
  const t = useT();

  return (
    <button
      type="button"
      onClick={() => {
        library.openExternal(guideUrl(slug)).catch((error: unknown) => {
          useApp.setState({ error: appError(error) });
        });
      }}
      className="flex items-center gap-1 px-1 py-1 text-sm font-medium text-accent"
    >
      {t(labelKey)}
      <span aria-hidden="true" className="rtl:-scale-x-100">
        <ForwardIcon />
      </span>
    </button>
  );
}
