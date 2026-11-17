import { useEffect, useRef, useState } from "react";

interface StepSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** The value as shown beside the slider, unit included. */
  format: (value: number) => string;
  onCommit: (value: number) => void;
}

/** A slider that shows the value while dragging and saves once on release, like `MarginSlider`. */
export function StepSlider({ label, value, min, max, step, format, onCommit }: StepSliderProps) {
  const input = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  const [dragging, setDragging] = useState<number | null>(null);

  useEffect(() => {
    commit.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const release = () => {
      commit.current(Number(element.value));
      setDragging(null);
    };
    element.addEventListener("change", release);
    return () => element.removeEventListener("change", release);
  }, []);

  const shown = dragging ?? value;
  return (
    <div className="flex items-center gap-3">
      <input
        ref={input}
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(event) => setDragging(Number(event.target.value))}
        className="min-w-0 flex-1 accent-accent"
      />
      <span className="w-16 text-end text-sm text-paper/70 tabular-nums">{format(shown)}</span>
    </div>
  );
}
