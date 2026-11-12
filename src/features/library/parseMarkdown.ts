/**
 * The small slice of Markdown a recipe's notes may use: headings, bullet and numbered lists,
 * paragraphs, `**bold**` and `` `code` ``. Links, images and raw HTML are not part of it, so
 * nothing a sender writes can load, navigate or inject; unrecognised syntax stays literal text.
 */
export type Inline = { kind: "text" | "bold" | "code"; text: string };

export type Block =
  | { kind: "heading"; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d{1,3}[.)]\s+(.*)$/;
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/;

export function parseInline(text: string): Inline[] {
  return text
    .split(INLINE)
    .filter((part) => part.length > 0)
    .map((part): Inline => {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
        return { kind: "bold", text: part.slice(2, -2) };
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
        return { kind: "code", text: part.slice(1, -1) };
      return { kind: "text", text: part };
    });
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const endParagraph = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    const item = bullet ?? numbered;
    const last = blocks[blocks.length - 1];

    if (line === "") {
      endParagraph();
    } else if (heading) {
      endParagraph();
      blocks.push({ kind: "heading", inlines: parseInline(heading[1]) });
    } else if (item) {
      endParagraph();
      const ordered = numbered !== null && bullet === null;
      const inlines = parseInline(item[1]);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(inlines);
      else blocks.push({ kind: "list", ordered, items: [inlines] });
    } else if (paragraph.length === 0 && last?.kind === "list" && /^\s/.test(raw)) {
      const items = last.items;
      items[items.length - 1] = [...items[items.length - 1], ...parseInline(` ${line}`)];
    } else {
      paragraph.push(line);
    }
  }
  endParagraph();
  return blocks;
}
