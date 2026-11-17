import { useState } from "react";
import { useT } from "../../i18n/useT";
import { describeError } from "../../i18n/errors";
import type { SiteSettings } from "../../shared/ipc";
import { recipeLibrary, type RecipePreview } from "../library/ipc";
import { RecipeReview } from "../library/RecipeReview";

/** Who made a recipe, and the recipe itself: every rule it applies, loaded when asked for. */
export function RecipeDetails({ site }: { site: SiteSettings }) {
  const t = useT();
  const [preview, setPreview] = useState<RecipePreview | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (preview) return;
    try {
      setPreview(await recipeLibrary.installedPreview(site.recipeId));
      setError(null);
    } catch (failure) {
      setError(describeError(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {site.author && (
        <p className="px-1 text-sm text-paper/55">{t("library.by", { author: site.author })}</p>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => void toggle()}
        className="self-start px-1 text-sm font-medium text-accent"
      >
        {t("library.review.rules")}
      </button>
      {open && error && <p className="px-1 text-sm text-paper/70">{error}</p>}
      {open && preview && <RecipeReview preview={preview} />}
    </div>
  );
}
