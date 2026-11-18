import { describe, expect, it } from "vitest";
import {
  chordFromEvent,
  formatSequence,
  normalizeSequence,
  toAccelerator,
  worksWhileTyping,
  type KeyLike,
} from "./chord";

const press = (key: string, code: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

describe("chordFromEvent", () => {
  it("reads Cmd as Mod on a Mac and Ctrl as Mod elsewhere", () => {
    const cmdL = press("l", "KeyL", { metaKey: true });
    const ctrlL = press("l", "KeyL", { ctrlKey: true });
    expect(chordFromEvent(cmdL, true)).toBe("Mod+l");
    expect(chordFromEvent(ctrlL, true)).toBe("Ctrl+l");
    expect(chordFromEvent(ctrlL, false)).toBe("Mod+l");
  });

  it("keeps the case of a bare key and does not add Shift to it", () => {
    expect(chordFromEvent(press("G", "KeyG", { shiftKey: true }), true)).toBe("G");
    expect(chordFromEvent(press("?", "Slash", { shiftKey: true }), false)).toBe("?");
  });

  it("uses the physical key when Alt rewrites what it types", () => {
    const optionV = press("√", "KeyV", { altKey: true });
    expect(chordFromEvent(optionV, true)).toBe("Alt+v");
    const optionLess = press("≤", "Comma", { altKey: true, shiftKey: true });
    expect(chordFromEvent(optionLess, true)).toBe("Alt+Shift+,");
  });

  it("names special keys and ignores a lone modifier", () => {
    expect(chordFromEvent(press(" ", "Space", { ctrlKey: true }), true)).toBe("Ctrl+Space");
    expect(chordFromEvent(press("Tab", "Tab", { ctrlKey: true, shiftKey: true }), true)).toBe(
      "Ctrl+Shift+Tab",
    );
    expect(chordFromEvent(press("Shift", "ShiftLeft", { shiftKey: true }), true)).toBeNull();
  });
});

describe("normalizeSequence", () => {
  it("makes Ctrl mean Mod off a Mac, so one preset serves both", () => {
    expect(normalizeSequence("Ctrl+x Ctrl+f", true)).toBe("Ctrl+x Ctrl+f");
    expect(normalizeSequence("Ctrl+x Ctrl+f", false)).toBe("Mod+x Mod+f");
  });

  it("reads a plus as a key and rejects unknown words", () => {
    expect(normalizeSequence("Mod++", true)).toBe("Mod++");
    expect(normalizeSequence("Mod+Shift+=", true)).toBe("Mod+Shift+=");
    expect(normalizeSequence("Hyper+x", true)).toBeNull();
    expect(normalizeSequence("  ", true)).toBeNull();
  });

  it("sorts modifiers so the same keys always read the same", () => {
    expect(normalizeSequence("Shift+Cmd+T", true)).toBe("Mod+Shift+t");
  });
});

describe("formatSequence", () => {
  it("writes symbols on a Mac and words elsewhere", () => {
    expect(formatSequence("Mod+Shift+t", true)).toBe("⌘⇧T");
    expect(formatSequence("Mod+Shift+t", false)).toBe("Ctrl+Shift+T");
    expect(formatSequence("g g", true)).toBe("g g");
  });
});

describe("toAccelerator", () => {
  it("gives the menu only single chords that have the command key", () => {
    expect(toAccelerator("Mod+l")).toBe("CmdOrCtrl+L");
    expect(toAccelerator("Mod+Alt+ArrowLeft")).toBe("CmdOrCtrl+Alt+Left");
    expect(toAccelerator("F5")).toBe("F5");
    expect(toAccelerator("j")).toBeNull();
    expect(toAccelerator("Ctrl+n")).toBeNull();
    expect(toAccelerator("Mod+k Mod+s")).toBeNull();
    expect(toAccelerator("Mod+c")).toBeNull();
  });
});

describe("worksWhileTyping", () => {
  it("lets Escape and command chords through a text field but not bare keys", () => {
    expect(worksWhileTyping("Escape")).toBe(true);
    expect(worksWhileTyping("Mod+l")).toBe(true);
    expect(worksWhileTyping("j")).toBe(false);
    expect(worksWhileTyping("Mod+v")).toBe(false);
  });
});
