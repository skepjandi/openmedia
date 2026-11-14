import { describe, expect, it } from "vitest";
import { parseSubject, releaseNotes, releaseTitle } from "./release-notes.mjs";

const subjects = [
  "chore(release): version 1.0.3 (#200)",
  "feat(store): panoramic App Store and Google Play artwork (#199)",
  "chore(deps): bump base64 from 0.22.1 to 0.23.1 in /src-tauri (#193)",
  "feat(history): clear all and delete single entries (#190)",
  "fix(fab): make the arrow visible on light pages (#189)",
  "Merge branch 'main'",
];

describe("release notes", () => {
  it("drops version bumps, dependency updates and non-conventional subjects", () => {
    expect(parseSubject(subjects[0])).toBeNull();
    expect(parseSubject(subjects[2])).toBeNull();
    expect(parseSubject(subjects[5])).toBeNull();
    expect(parseSubject(subjects[1])).toEqual({
      type: "feat",
      scope: "store",
      text: "panoramic App Store and Google Play artwork",
      pr: "199",
    });
  });

  it("titles the release with the newest feature", () => {
    expect(releaseTitle("1.0.3", subjects)).toBe(
      "OpenMedia 1.0.3: Panoramic App Store and Google Play artwork",
    );
    expect(releaseTitle("1.0.3", ["chore(deps): bump x (#1)"])).toBe("OpenMedia 1.0.3");
  });

  it("groups changes, links pull requests and the full changelog", () => {
    const notes = releaseNotes({
      version: "1.0.3",
      previousTag: "v1.0.2",
      subjects,
      repository: "o/r",
    });
    expect(notes).toContain("## New\n\n- **store**: Panoramic");
    expect(notes).toContain("([#190](https://github.com/o/r/pull/190))");
    expect(notes).toContain("## Fixed\n\n- **fab**: Make the arrow");
    expect(notes).toContain("https://github.com/o/r/compare/v1.0.2...v1.0.3");
    expect(notes).not.toContain("deps");
  });
});
