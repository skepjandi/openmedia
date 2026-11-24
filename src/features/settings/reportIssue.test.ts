import { describe, expect, it } from "vitest";
import { platformName, reportIssueUrl } from "./reportIssue";

describe("platformName", () => {
  it("names the system from the user agent, telling Android from Linux", () => {
    expect(platformName("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("Android");
    expect(platformName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux");
    expect(platformName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(platformName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iOS");
    expect(platformName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macOS");
  });
});

describe("reportIssueUrl", () => {
  it("opens a new bug issue on the project repository with version and platform filled in", () => {
    const url = new URL(reportIssueUrl("1.0.5", "Windows"));
    expect(url.origin + url.pathname).toBe("https://github.com/skepjandi/openmedia/issues/new");
    expect(url.searchParams.get("labels")).toBe("bug");
    expect(url.searchParams.get("body")).toContain("Windows, OpenMedia 1.0.5");
  });

  it("still works when the version could not be read", () => {
    const body = new URL(reportIssueUrl(null, "Linux")).searchParams.get("body");
    expect(body).toContain("Linux, OpenMedia unknown version");
  });
});
