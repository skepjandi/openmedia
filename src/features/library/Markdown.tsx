import { parseMarkdown, type Inline } from "./parseMarkdown";

/** Renders notes as React elements only: the sender's text is never interpreted as HTML. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="flex flex-col gap-2.5 text-sm leading-relaxed text-paper/70">
      {parseMarkdown(source).map((block, index) => {
        if (block.kind === "heading")
          return (
            <p key={index} className="mt-1 text-sm font-semibold text-paper/90">
              <Inlines inlines={block.inlines} />
            </p>
          );
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={index}
              className={`flex flex-col gap-1.5 ps-5 ${block.ordered ? "list-decimal" : "list-disc"}`}
            >
              {block.items.map((inlines, item) => (
                <li key={item}>
                  <Inlines inlines={inlines} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={index}>
            <Inlines inlines={block.inlines} />
          </p>
        );
      })}
    </div>
  );
}

function Inlines({ inlines }: { inlines: Inline[] }) {
  return inlines.map((inline, index) => {
    if (inline.kind === "bold")
      return (
        <strong key={index} className="font-semibold text-paper/90">
          {inline.text}
        </strong>
      );
    if (inline.kind === "code")
      return (
        <code key={index} className="rounded bg-paper/10 px-1 py-px text-[13px] break-all">
          {inline.text}
        </code>
      );
    return <span key={index}>{inline.text}</span>;
  });
}
