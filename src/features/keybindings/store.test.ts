import { beforeEach, describe, expect, it } from "vitest";
import { effectiveBindings } from "./keymap";
import { hasWayBack, selectFabHidden, useKeybindings } from "./store";

describe("the floating button's visibility", () => {
  beforeEach(() => {
    useKeybindings.setState({ enabled: true, showFab: true, overrides: {}, profile: "standard" });
  });

  it("is hidden only while shortcuts are on", () => {
    expect(selectFabHidden({ enabled: true, showFab: false })).toBe(true);
    expect(selectFabHidden({ enabled: false, showFab: false })).toBe(false);
    expect(selectFabHidden({ enabled: true, showFab: true })).toBe(false);
  });

  it("is shown again once shortcuts are turned off, and stays so when they come back", () => {
    useKeybindings.getState().setShowFab(false);
    useKeybindings.getState().setEnabled(false);
    useKeybindings.getState().setEnabled(true);
    expect(selectFabHidden(useKeybindings.getState())).toBe(false);
  });

  it("has a way back by default, and none once Settings, the palette and the toggle are unbound", () => {
    const standard = effectiveBindings("standard", {}, true);
    expect(hasWayBack(standard)).toBe(true);
    const stripped = effectiveBindings(
      "standard",
      { "app.fab": [], "app.palette": [], "nav.settings": [] },
      true,
    );
    expect(hasWayBack(stripped)).toBe(false);
  });
});
