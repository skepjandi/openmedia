import { useEffect, useSyncExternalStore } from "react";
import { selectPage, useApp } from "../../app/store";
import { canStepBack } from "../web/sessions";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { app } from "../../shared/ipc";
import { isAndroid } from "../../shared/platform";
import { useLimitBlock } from "../stats/UsageGuard";
import { hasBackHandler, runBackHandler, subscribeBackHandlers } from "./backStack";

/**
 * Android's Back button and edge gesture. Only while the app has something to do with a press
 * (a handler on screen, or a page with history) is the press taken from the system; otherwise the
 * system default runs and leaves the app.
 */
export function useAndroidBack() {
  const t = useT();
  const reportError = useApp((s) => s.reportError);
  const canGoBack = useApp((s) => canStepBack(selectPage(s)));
  const { blocked } = useLimitBlock();
  const hasHandler = useSyncExternalStore(subscribeBackHandlers, hasBackHandler);
  const wanted = isAndroid() && (hasHandler || (canGoBack && !blocked));

  useEffect(() => {
    if (!wanted) return;
    let stopped = false;
    let listener: { unregister: () => Promise<void> } | null = null;
    app
      .onBackButton(() => {
        if (runBackHandler()) return;
        useApp
          .getState()
          .goBack()
          .catch((error: unknown) => reportError(describeError(error, t)));
      })
      .then((registered) => {
        if (stopped) void registered.unregister();
        else listener = registered;
      })
      .catch(() => {});
    return () => {
      stopped = true;
      void listener?.unregister();
    };
  }, [wanted, reportError, t]);
}
