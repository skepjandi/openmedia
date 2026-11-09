import { useEffect } from "react";
import { Screen } from "../../shared/Screen";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { legalConfigured, PRIVACY_POLICY_URL, TERMS_URL } from "./legal";
import { useEntitlementStore } from "./store";

/** Full-screen purchase surface. Prices and trial eligibility come from the store. */
export function PaywallSheet() {
  const t = useT();
  const status = useEntitlementStore((state) => state.status);
  const closeSheet = useApp((state) => state.closeSheet);
  const openAddress = useApp((state) => state.openAddress);
  const configured = useEntitlementStore((state) => state.configured);
  const packages = useEntitlementStore((state) => state.packages);
  const purchasing = useEntitlementStore((state) => state.purchasing);
  const restoring = useEntitlementStore((state) => state.restoring);
  const error = useEntitlementStore((state) => state.error);
  const loadOfferings = useEntitlementStore((state) => state.loadOfferings);
  const purchase = useEntitlementStore((state) => state.purchase);
  const restore = useEntitlementStore((state) => state.restore);
  const byKind = new Map(packages.map((item) => [item.kind, item]));
  useEffect(() => {
    if (configured && status === "free" && packages.length === 0) void loadOfferings();
  }, [configured, status, packages.length, loadOfferings]);
  const plans = [
    { kind: "lifetime", label: t("paywall.lifetime"), priceKey: "paywall.priceLifetime" },
    { kind: "yearly", label: t("paywall.yearly"), priceKey: "paywall.priceYearly" },
    { kind: "monthly", label: t("paywall.monthly"), priceKey: "paywall.priceMonthly" },
  ] as const;
  const showError =
    error === "paywall.error"
      ? t("paywall.error")
      : error === "paywall.pending"
        ? t("paywall.pending")
        : error === "paywall.nothingToRestore"
          ? t("paywall.nothingToRestore")
          : error;

  return (
    <Screen
      title={t("paywall.title")}
      subtitle={t("paywall.subtitle")}
      closeLabel={t("paywall.close")}
      onClose={closeSheet}
    >
      {configured && status === "loading" ? (
        <p className="py-8 text-center text-sm text-paper/60">{t("paywall.loading")}</p>
      ) : !configured ? (
        <p className="rounded-2xl border border-hair bg-paper/[0.04] p-4 text-sm text-paper/65">
          {t("paywall.unavailable")}
        </p>
      ) : (
        <div className="space-y-3">
          {plans.map(({ kind, label, priceKey }, index) => {
            const item = byKind.get(kind);
            return (
              <button
                key={kind}
                type="button"
                data-testid={`paywall.plan.${kind}`}
                disabled={!item || !legalConfigured || purchasing !== null}
                onClick={() =>
                  item &&
                  void purchase(item.id).then((outcome) => {
                    if (outcome === "purchased" && useEntitlementStore.getState().status === "pro")
                      closeSheet();
                  })
                }
                className={`w-full rounded-2xl border p-4 text-start disabled:opacity-45 ${index === 0 ? "border-accent bg-accent/10" : "border-hair bg-paper/[0.04]"}`}
              >
                <span className="flex items-center justify-between gap-4">
                  <span className="font-semibold">{label}</span>
                  <span className="text-sm text-paper/75">
                    {item ? t(priceKey, { price: item.price }) : "—"}
                  </span>
                </span>
                {kind === "monthly" &&
                  item?.trialDays !== null &&
                  item?.trialDays !== undefined && (
                    <span className="mt-1 block text-sm text-accent">
                      {t("paywall.trialDays", { days: item.trialDays })}
                    </span>
                  )}
                {purchasing === item?.id && (
                  <span className="mt-2 block text-xs text-paper/60">
                    {t("paywall.purchasing")}
                  </span>
                )}
              </button>
            );
          })}
          {packages.length === 0 && !error && (
            <p className="text-center text-sm text-paper/60">{t("paywall.empty")}</p>
          )}
          {error && (
            <p role="status" className="text-sm text-red-300">
              {showError}
            </p>
          )}
          {error && (
            <button
              type="button"
              className="w-full rounded-full border border-hair px-4 py-3 text-sm"
              onClick={() => void loadOfferings()}
            >
              {t("common.retry")}
            </button>
          )}
          {!legalConfigured && (
            <p role="status" className="text-sm text-paper/60">
              {t("paywall.legalUnavailable")}
            </p>
          )}
          <p className="text-xs leading-relaxed text-paper/50">{t("paywall.disclosure")}</p>
          {legalConfigured && (
            <div className="flex justify-center gap-5 text-sm text-paper/65">
              <button
                type="button"
                onClick={() => PRIVACY_POLICY_URL && openAddress(PRIVACY_POLICY_URL)}
              >
                {t("paywall.privacy")}
              </button>
              <button type="button" onClick={() => TERMS_URL && openAddress(TERMS_URL)}>
                {t("paywall.terms")}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="mt-6 space-y-3">
        <button
          type="button"
          data-testid="paywall.restore"
          disabled={restoring}
          onClick={() =>
            void restore().then(() => {
              if (useEntitlementStore.getState().status === "pro") closeSheet();
            })
          }
          className="w-full rounded-full border border-hair px-4 py-3 text-sm font-semibold disabled:opacity-50"
        >
          {restoring ? t("paywall.restoring") : t("paywall.restore")}
        </button>
        {restoring && <p className="text-center text-xs text-paper/55">{t("paywall.restoring")}</p>}
      </div>
    </Screen>
  );
}
