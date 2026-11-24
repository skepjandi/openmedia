const NEW_ISSUE_URL = "https://github.com/skepjandi/openmedia/issues/new";

/** The operating system as a person would name it, for the report. Nothing here identifies the user. */
export function platformName(userAgent: string = navigator.userAgent): string {
  if (/Android/i.test(userAgent)) return "Android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "iOS";
  if (/Macintosh/.test(userAgent)) return "macOS";
  if (/Windows NT/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return "unknown";
}

/**
 * The address of a new GitHub issue with the bug-report template filled in as far as the app
 * knows: its version and the operating system. The user reads and edits it on GitHub before
 * anything is submitted; the app sends nothing itself.
 */
export function reportIssueUrl(version: string | null, platform: string = platformName()): string {
  const body = [
    "**What happened / expected**",
    "",
    "",
    "**Steps to reproduce**",
    "",
    "",
    `**Platform** (macOS / iOS / Android / Windows / Linux, app version)`,
    `${platform}, OpenMedia ${version ?? "unknown version"}`,
    "",
    "**Site and recipe involved (if any)**",
    "",
  ].join("\n");
  const query = new URLSearchParams({ labels: "bug", body });
  return `${NEW_ISSUE_URL}?${query.toString()}`;
}
