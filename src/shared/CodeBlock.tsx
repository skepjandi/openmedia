import { useId, useState } from "react";

interface CodeBlockProps {
  code: string;
  showLabel: string;
  hideLabel: string;
}

/**
 * Source code behind a toggle, collapsed by default. The code is a React text child in a
 * monospace, horizontally scrollable block: it is never parsed as markup.
 */
export function CodeBlock({ code, showLabel, hideLabel }: CodeBlockProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <div className="mt-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="text-xs font-medium text-accent"
      >
        {open ? hideLabel : showLabel}
      </button>
      {open && (
        <pre
          id={id}
          tabIndex={0}
          className="mt-1.5 max-h-72 overflow-auto rounded-lg border border-hair bg-paper/[0.05] p-2.5 font-mono text-[12px] leading-snug whitespace-pre text-paper/85"
        >
          {code}
        </pre>
      )}
    </div>
  );
}

/** A small rounded label, for facts like "Runs code". */
export function Chip({ children }: { children: string }) {
  return (
    <span className="inline-block shrink-0 rounded-full border border-accent/50 px-2 py-0.5 text-[11px] font-medium text-accent">
      {children}
    </span>
  );
}
