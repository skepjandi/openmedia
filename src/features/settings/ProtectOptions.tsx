import { useEffect } from "react";
import { appError, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import type { SiteSettings } from "../../shared/ipc";
import { usageLock, useUsageLock } from "../stats/lock";
import { Switch } from "./Switch";
import { Group, GroupLabel } from "./ui";

/**
 * Lets the reader hold a site's options to their current value with the settings lock: while the
 * lock is on, a protected option cannot be changed. Hidden when Usage is not available (no Pro),
 * since the lock lives there.
 */
export function ProtectOptions({ site }: { site: SiteSettings }) {
  const t = useT();
  const status = useUsageLock((state) => state.status);
  const loaded = useUsageLock((state) => state.loaded);
  const reportError = useApp((state) => state.reportError);

  useEffect(() => {
    if (!loaded) usageLock.load().catch(() => {});
  }, [loaded]);

  if (!loaded || site.options.length === 0) return null;
  const isProtected = (optionId: string) =>
    status.protectedOptions.some(
      (entry) => entry.recipeId === site.recipeId && entry.optionId === optionId,
    );
  const toggle = (optionId: string, on: boolean) => {
    const change = on
      ? usageLock.protect(site.recipeId, optionId)
      : usageLock.unprotect(site.recipeId, optionId);
    change.catch((error: unknown) => reportError(appError(error)));
  };

  return (
    <div>
      <GroupLabel>{t("usage.lock.protectTitle")}</GroupLabel>
      <Group>
        {site.options.map((option) => (
          <Switch
            key={option.id}
            label={option.label}
            description={t("usage.lock.protectHint")}
            checked={isProtected(option.id)}
            onChange={(on) => toggle(option.id, on)}
          />
        ))}
      </Group>
    </div>
  );
}
