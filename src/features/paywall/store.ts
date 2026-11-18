import { create } from "zustand";
import { isStorelessDesktop } from "../../shared/platform";
import { paywall, type EntitlementView, type Package, type PurchaseOutcome } from "./ipc";

interface EntitlementState extends EntitlementView {
  packages: Package[];
  purchasing: string | null;
  restoring: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  loadOfferings: () => Promise<void>;
  purchase: (packageId: string) => Promise<PurchaseOutcome | null>;
  restore: () => Promise<void>;
}

/** Windows and Linux have no store and start Pro, so no lock or paywall shows before Rust answers. */
const initialView = (): EntitlementView => ({
  status: isStorelessDesktop() ? "pro" : "loading",
  configured: false,
  snapshot: null,
});
let initialized = false;
let unsubscribe: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;

export const useEntitlementStore = create<EntitlementState>((set, get) => ({
  ...initialView(),
  packages: [],
  purchasing: null,
  restoring: false,
  error: null,
  initialize: async () => {
    if (initialized) return;
    initialized = true;
    unsubscribe = await paywall
      .onChanged((view) => {
        set({ ...view, packages: view.configured ? get().packages : [] });
      })
      .catch(() => null);
    try {
      const view = await paywall.getEntitlement();
      set(view);
    } catch {
      // Rust keeps a known entitlement on errors and retries startup in the background.
    }
    if (typeof document !== "undefined") {
      visibilityHandler = () => {
        if (document.visibilityState === "visible") {
          void paywall
            .refreshEntitlement()
            .then((view) => set(view))
            .catch(() => {});
        }
      };
      document.addEventListener("visibilitychange", visibilityHandler);
    }
  },
  loadOfferings: async () => {
    if (!get().configured) return;
    try {
      set({ packages: await paywall.getOfferings(), error: null });
    } catch {
      set({ packages: [], error: "paywall.error" });
    }
  },
  purchase: async (packageId) => {
    set({ purchasing: packageId, error: null });
    try {
      const result = await paywall.purchase(packageId);
      set({
        ...result.view,
        purchasing: null,
        error:
          result.outcome === "pending"
            ? "paywall.pending"
            : result.outcome === "purchased" && result.view.status !== "pro"
              ? "paywall.error"
              : null,
      });
      return result.outcome;
    } catch {
      set({ purchasing: null, error: "paywall.error" });
      return null;
    }
  },
  restore: async () => {
    set({ restoring: true, error: null });
    try {
      const view = await paywall.restore();
      set({
        ...view,
        restoring: false,
        error: view.status === "pro" ? null : "paywall.nothingToRestore",
      });
    } catch {
      set({ restoring: false, error: "paywall.error" });
    }
  },
}));

export function resetEntitlementStoreForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (visibilityHandler && typeof document !== "undefined")
    document.removeEventListener("visibilitychange", visibilityHandler);
  visibilityHandler = null;
  initialized = false;
  useEntitlementStore.setState({
    ...initialView(),
    packages: [],
    purchasing: null,
    restoring: false,
    error: null,
  });
}
