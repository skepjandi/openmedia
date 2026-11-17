import { useEffect, useRef, useState } from "react";

interface ColorInputProps {
  label: string;
  value: string;
  onCommit: (color: string) => void;
}

/** A colour picker that saves once the picker closes, not on every drag. */
export function ColorInput({ label, value, onCommit }: ColorInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => {
    commit.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const release = () => {
      commit.current(element.value.toLowerCase());
      setPicking(null);
    };
    element.addEventListener("change", release);
    return () => element.removeEventListener("change", release);
  }, []);

  return (
    <input
      ref={input}
      type="color"
      aria-label={label}
      value={picking ?? value}
      onChange={(event) => setPicking(event.target.value)}
      className="h-10 w-14 shrink-0 cursor-pointer rounded-lg border border-hair bg-transparent p-1"
    />
  );
}
