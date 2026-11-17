import { describe, expect, it } from "vitest";
import { groupTech } from "./TechPanel";

describe("groupTech", () => {
  it("lists categories in a fixed order and leaves empty ones out", () => {
    const groups = groupTech([
      { name: "Cloudflare", category: "delivery" },
      { name: "React", category: "framework" },
      { name: "Vue.js", category: "framework" },
    ]);
    expect(groups.map((group) => group.id)).toEqual(["framework", "delivery"]);
    expect(groups[0].names).toEqual(["React", "Vue.js"]);
  });
});
