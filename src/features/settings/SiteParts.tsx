import { useT } from "../../i18n/useT";
import { ForwardIcon } from "../../shared/icons";

/** A page's row in a list: a title, a line under it, and a chevron that points the way the page opens. */
export function NavRow({
  title,
  note,
  onClick,
}: {
  title: string;
  note: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-start hover:bg-paper/[0.04] active:bg-paper/[0.05] desktop:py-3"
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

/** What a site's page knows about its own entry: the fields it sets, and how to hand some back to general. */
export interface SiteOverrides<Entry extends object> {
  own: Entry;
  follow: (fields: (keyof Entry)[]) => void;
}

interface FollowGeneralProps<Entry extends object> {
  overrides: SiteOverrides<Entry> | undefined;
  /** The fields of the entry that this setting writes. */
  fields: (keyof Entry)[];
  /** The setting's name, for the button's accessible label. */
  label: string;
  /** Spacing around the marker, which depends on the row it sits in. */
  className?: string;
}

/**
 * Under a setting on a site's page: marks it as the site's own and offers to follow general again.
 * Nothing shows on a general page (no overrides) or while the site follows general.
 */
export function FollowGeneral<Entry extends object>({
  overrides,
  fields,
  label,
  className = "",
}: FollowGeneralProps<Entry>) {
  const t = useT();
  if (!overrides || !fields.some((field) => overrides.own[field] !== undefined)) return null;

  return (
    <div className={`flex items-center justify-between gap-3 text-xs ${className}`}>
      <span className="flex items-center gap-2 text-accent">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
        {t("site.overridden")}
      </span>
      <button
        type="button"
        aria-label={t("site.followGeneralFor", { setting: label })}
        onClick={() => overrides.follow(fields)}
        className="font-medium text-accent underline underline-offset-2"
      >
        {t("favorites.darkFollow")}
      </button>
    </div>
  );
}
