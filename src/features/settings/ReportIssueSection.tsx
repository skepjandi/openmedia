import { appError, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { library, updates } from "../../shared/ipc";
import { Group, Section, quietButton } from "./ui";
import { reportIssueUrl } from "./reportIssue";

/**
 * Opens a new GitHub issue in the system browser with the app version and system filled in. The
 * user reviews it there; the app itself sends nothing.
 */
export function ReportIssueSection() {
  const t = useT();

  const open = async () => {
    const version = await updates.status().then(
      (status) => status.runtimeVersion,
      () => null,
    );
    library.openExternal(reportIssueUrl(version)).catch((error: unknown) => {
      useApp.setState({ error: appError(error) });
    });
  };

  return (
    <Section title={t("settings.report")}>
      <Group>
        <div className="flex items-center justify-between gap-3 px-4 py-3.5">
          <div className="min-w-0 text-sm text-paper/55">{t("settings.reportNote")}</div>
          <button type="button" onClick={() => void open()} className={quietButton}>
            {t("settings.reportOpen")}
          </button>
        </div>
      </Group>
    </Section>
  );
}
