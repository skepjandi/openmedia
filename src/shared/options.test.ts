import { describe, expect, it } from "vitest";
import type { SiteOption } from "./ipc";
import { currentLabel, isActive, isChoiceOption, offValue } from "./options";

const base = { id: "x", label: "X", description: "", group: "content" } as const;

const toggle: SiteOption = { ...base, choices: [], value: true, default: false };
const choice: SiteOption = {
  ...base,
  choices: [
    { id: "show", label: "Show" },
    { id: "blur", label: "Blur" },
    { id: "hide", label: "Hide" },
  ],
  value: "blur",
  default: "show",
};

describe("site option helpers", () => {
  it("tells a choice option from a switch", () => {
    expect(isChoiceOption(toggle)).toBe(false);
    expect(isChoiceOption(choice)).toBe(true);
  });

  it("leaves the page alone at off: false for a switch, the first choice otherwise", () => {
    expect(offValue(toggle)).toBe(false);
    expect(offValue(choice)).toBe("show");
  });

  it("counts a switch as active when on and a choice option when it is not the first state", () => {
    expect(isActive(toggle)).toBe(true);
    expect(isActive({ ...toggle, value: false })).toBe(false);
    expect(isActive(choice)).toBe(true);
    expect(isActive({ ...choice, value: "show" })).toBe(false);
  });

  it("names the state a choice option is in", () => {
    expect(currentLabel(choice)).toBe("Blur");
  });
});
