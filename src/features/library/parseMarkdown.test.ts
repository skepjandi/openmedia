import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./parseMarkdown";

const text = (value: string) => ({ kind: "text", text: value });

describe("parseMarkdown", () => {
  it("joins wrapped lines into a paragraph and splits on blank lines", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { kind: "paragraph", inlines: [text("one two")] },
      { kind: "paragraph", inlines: [text("three")] },
    ]);
  });

  it("groups consecutive bullets and keeps ordered lists apart from them", () => {
    const blocks = parseMarkdown("- a\n- b\n1. c\n2. d");
    expect(blocks).toEqual([
      { kind: "list", ordered: false, items: [[text("a")], [text("b")]] },
      { kind: "list", ordered: true, items: [[text("c")], [text("d")]] },
    ]);
  });

  it("reads a heading and ends the paragraph before it", () => {
    expect(parseMarkdown("intro\n## Checked\nbody")).toEqual([
      { kind: "paragraph", inlines: [text("intro")] },
      { kind: "heading", inlines: [text("Checked")] },
      { kind: "paragraph", inlines: [text("body")] },
    ]);
  });

  it("folds an indented line into the bullet above it", () => {
    expect(parseMarkdown("- first\n  more")).toEqual([
      { kind: "list", ordered: false, items: [[text("first"), text(" more")]] },
    ]);
  });

  it("leaves links, images and HTML as literal text", () => {
    const source = "[x](https://evil.test) ![i](https://evil.test/p.png) <img src=x onerror=1>";
    expect(parseMarkdown(source)).toEqual([{ kind: "paragraph", inlines: [text(source)] }]);
  });
});

describe("parseInline", () => {
  it("marks bold and code and leaves unbalanced markers alone", () => {
    expect(parseInline("a **b** `c` **d")).toEqual([
      text("a "),
      { kind: "bold", text: "b" },
      text(" "),
      { kind: "code", text: "c" },
      text(" **d"),
    ]);
  });
});
