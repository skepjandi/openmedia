import { describe, expect, it } from "vitest";
import { ACTIONS } from "./actionList";
import { conflictsOf, effectiveBindings, Matcher, type Press } from "./keymap";
import { PROFILES, profileBindings } from "./presets";

const run = (action: string, count = 1): Press => ({ kind: "run", action, count });

function matcherFor(profile: "standard" | "vim" | "emacs", overrides = {}) {
  return new Matcher(effectiveBindings(profile, overrides, true), profile);
}

describe("presets", () => {
  it("bind only actions that exist, with readable keys", () => {
    const ids = new Set(ACTIONS.map((info) => info.id));
    for (const profile of PROFILES) {
      for (const mac of [true, false]) {
        for (const [id, sequences] of profileBindings(profile, mac)) {
          expect(ids.has(id), `${profile}: ${id}`).toBe(true);
          expect(sequences.length).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("never give one key to two actions", () => {
    for (const profile of PROFILES) {
      for (const mac of [true, false]) {
        const owner = new Map<string, string>();
        for (const [id, sequences] of effectiveBindings(profile, {}, mac)) {
          for (const sequence of sequences) {
            expect(owner.get(sequence), `${profile} ${sequence}`).toBeUndefined();
            owner.set(sequence, id);
          }
        }
      }
    }
  });
});

describe("Matcher", () => {
  it("runs a single chord at once", () => {
    expect(matcherFor("standard").press("Mod+l", false)).toEqual(run("nav.address"));
  });

  it("waits through a sequence and runs it on the last chord", () => {
    const matcher = matcherFor("vim");
    expect(matcher.press("g", false)).toEqual({ kind: "pending" });
    expect(matcher.press("g", false)).toEqual(run("view.top"));
  });

  it("starts over with the chord that broke a sequence", () => {
    const matcher = matcherFor("vim");
    matcher.press("g", false);
    expect(matcher.press("j", false)).toEqual(run("view.down"));
  });

  it("repeats an action by the count typed before it, in Vim only", () => {
    const vim = matcherFor("vim");
    vim.press("1", false);
    vim.press("2", false);
    expect(vim.press("j", false)).toEqual(run("view.down", 12));
    expect(matcherFor("standard").press("1", false)).toEqual({ kind: "none" });
  });

  it("runs the first part of an ambiguous binding when the wait runs out", () => {
    const matcher = matcherFor("standard", { "nav.back": ["g"], "nav.forward": ["g g"] });
    expect(matcher.press("g", false)).toEqual({ kind: "pending" });
    expect(matcher.expire()).toEqual(run("nav.back"));
  });

  it("keeps bare keys out of text fields but lets command chords in", () => {
    const matcher = matcherFor("vim");
    expect(matcher.press("j", true)).toEqual({ kind: "none" });
    expect(matcher.press("Mod+l", true)).toEqual(run("nav.address"));
  });

  it("follows Emacs prefix keys", () => {
    const matcher = matcherFor("emacs");
    expect(matcher.press("Ctrl+x", false)).toEqual({ kind: "pending" });
    expect(matcher.press("Ctrl+f", false)).toEqual(run("nav.address"));
  });
});

describe("effectiveBindings", () => {
  it("replaces an action's default keys with the person's", () => {
    const bindings = effectiveBindings("standard", { "nav.reload": ["Mod+Shift+r"] }, true);
    expect(bindings.get("nav.reload")).toEqual(["Mod+Shift+r"]);
  });

  it("takes keys from the action that had them when the person rebinds them", () => {
    const bindings = effectiveBindings("standard", { "nav.history": ["Mod+l"] }, true);
    expect(bindings.get("nav.history")).toEqual(["Mod+l"]);
    expect(bindings.get("nav.address")).toEqual([]);
  });

  it("lets Vim's own keys win over Standard's where they clash", () => {
    const bindings = effectiveBindings("vim", {}, false);
    expect(bindings.get("view.pageDown")).toContain("Mod+f");
    expect(bindings.get("page.find")).not.toContain("Mod+f");
  });
});

describe("conflictsOf", () => {
  it("names the actions whose keys equal or begin the new ones", () => {
    const bindings = effectiveBindings("vim", {}, true);
    expect(conflictsOf(bindings, "nav.back", "g")).toEqual(
      expect.arrayContaining(["view.top", "nav.history"]),
    );
    expect(conflictsOf(bindings, "nav.back", "Mod+l")).toEqual(["nav.address"]);
  });
});
