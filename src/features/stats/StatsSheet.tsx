import { useEffect, useState } from "react";
import { useApp } from "../../app/store";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import { Screen } from "../../shared/Screen";
import { ActivityTab } from "./ActivityTab";
import { LimitsTab } from "./LimitsTab";
import { useUsageView, type UsageTab } from "./view";

const TABS: { id: UsageTab; label: MessageKey }[] = [
  { id: "activity", label: "stats.tabActivity" },
  { id: "limits", label: "stats.tabLimits" },
];

/** Time on sites and the daily limits that act on it. Full-screen so no page shows through. */
export function StatsSheet() {
  const open = useApp((s) => s.sheet === "stats");
  const closeSheet = useApp((s) => s.closeSheet);
  const tab = useUsageView((s) => s.tab);
  const setTab = useUsageView((s) => s.setTab);
  const [days, setDays] = useState(7);
  const t = useT();

  useEffect(() => {
    if (!open) useUsageView.setState({ tab: "activity", focusHost: null });
  }, [open]);

  if (!open) return null;

  return (
    <Screen
      title={t("stats.title")}
      subtitle={t("stats.subtitle")}
      closeLabel={t("stats.close")}
      onClose={closeSheet}
    >
      <div
        role="tablist"
        aria-label={t("stats.title")}
        className="mb-6 flex gap-7 border-b border-hair"
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-1 pb-3 text-base font-semibold ${
              tab === id ? "border-accent text-paper" : "border-transparent text-paper/50"
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {tab === "activity" ? <ActivityTab days={days} onDays={setDays} /> : <LimitsTab />}
    </Screen>
  );
}
