import { useApp } from "../../app/store";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import type { DetectedTech, TechCategory } from "../../shared/ipc";
import { Spinner } from "../../shared/Spinner";

const CATEGORIES: { id: TechCategory; label: MessageKey }[] = [
  { id: "framework", label: "tech.cat.framework" },
  { id: "platform", label: "tech.cat.platform" },
  { id: "analytics", label: "tech.cat.analytics" },
  { id: "service", label: "tech.cat.service" },
  { id: "design", label: "tech.cat.design" },
  { id: "delivery", label: "tech.cat.delivery" },
];

/** The technologies in each category, in the order the categories are shown; empty ones left out. */
export function groupTech(items: DetectedTech[]) {
  return CATEGORIES.map(({ id, label }) => ({
    id,
    label,
    names: items.filter((item) => item.category === id).map((item) => item.name),
  })).filter((group) => group.names.length > 0);
}

/** What the page in front is built with, as a card over the page. */
export function TechPanel() {
  const tech = useApp((s) => s.tech);
  const endTechDetect = useApp((s) => s.endTechDetect);
  const t = useT();
  if (!tech) return null;

  const groups = tech.status === "done" ? groupTech(tech.items) : [];

  return (
    <div
      data-hit=""
      role="dialog"
      aria-label={t("tech.title")}
      className="glass fixed inset-x-3 bottom-[calc(var(--safe-bottom)+12px)] z-[85] flex max-h-[60vh] flex-col rounded-2xl text-sm text-paper"
    >
      <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        <h2 className="min-w-0 flex-1 text-base font-medium">{t("tech.title")}</h2>
        <button
          type="button"
          onClick={endTechDetect}
          className="rounded-full px-3 py-1.5 text-accent active:bg-paper/[0.08]"
        >
          {t("common.done")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {tech.status === "loading" ? (
          <div className="flex items-center gap-3 py-3 text-paper/70">
            <Spinner />
            {t("tech.loading")}
          </div>
        ) : groups.length === 0 ? (
          <p className="py-3 text-paper/70">{t("tech.none")}</p>
        ) : (
          groups.map((group) => (
            <section key={group.id} className="py-1.5">
              <h3 className="text-xs tracking-wide text-paper/55 uppercase">{t(group.label)}</h3>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {group.names.map((name) => (
                  <li key={name} className="rounded-full border border-hair px-3 py-1">
                    {name}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        {tech.status === "done" && (
          <p className="pt-2 text-xs leading-snug text-paper/50">{t("tech.note")}</p>
        )}
      </div>
    </div>
  );
}
