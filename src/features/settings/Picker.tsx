import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "../../i18n/useT";
import { useBackHandler } from "../back/useBackHandler";
import { CheckIcon, CloseIcon } from "../../shared/icons";
import { field } from "./ui";

export interface PickerOption {
  value: string;
  label: string;
}

interface PickerProps {
  /** Names the control for screen readers and titles the list. */
  label: string;
  value: string;
  options: readonly PickerOption[];
  onChange: (value: string) => void;
}

/** How far down, in pixels, a drag must go to dismiss the sheet. */
const DISMISS_DISTANCE = 100;
/** Movement before a touch counts as a drag, so a tap on an option stays a tap. */
const DRAG_SLOP = 8;

/**
 * Lets a downward drag pull `sheet` off the screen and calls `onDismiss` when it passes
 * `DISMISS_DISTANCE`. A drag that starts inside a scrolled `list` belongs to the list.
 */
function useDragToDismiss(
  active: boolean,
  sheet: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  const latest = useRef(onDismiss);
  useEffect(() => {
    latest.current = onDismiss;
  });
  useEffect(() => {
    const element = sheet.current;
    if (!active || !element) return;
    let startY: number | null = null;
    let offset = 0;
    let dragging = false;

    const begin = (event: TouchEvent) => {
      const inList = event.target instanceof Node && list.current?.contains(event.target);
      const canDrag = !inList || (list.current?.scrollTop ?? 0) <= 0;
      startY = event.touches.length === 1 && canDrag ? event.touches[0].clientY : null;
      offset = 0;
      dragging = false;
      element.style.transition = "none";
    };
    const move = (event: TouchEvent) => {
      if (startY === null) return;
      const delta = event.touches[0].clientY - startY;
      if (!dragging) {
        // Upward first: the list scrolls, so this touch is not ours.
        if (delta < -DRAG_SLOP) startY = null;
        if (delta <= DRAG_SLOP) return;
        dragging = true;
      }
      event.preventDefault();
      offset = Math.max(0, delta);
      element.style.transform = `translateY(${offset}px)`;
    };
    const end = () => {
      startY = null;
      if (!dragging) return;
      dragging = false;
      if (offset > DISMISS_DISTANCE) {
        latest.current();
        return;
      }
      element.style.transition = "transform 200ms var(--ease-spring, ease-out)";
      element.style.transform = "";
    };

    element.addEventListener("touchstart", begin, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end, { passive: true });
    element.addEventListener("touchcancel", end, { passive: true });
    return () => {
      element.removeEventListener("touchstart", begin);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", end);
    };
  }, [active, sheet, list]);
}

/**
 * A choice from a list. A native `<select>` opens the system's own light dialog on Android, which
 * ignores the app's theme, so the list is drawn here instead. It closes with its button, a tap
 * outside, Back, or a drag down.
 */
export function Picker({ label, value, options, onChange }: PickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useBackHandler(open, close);
  useDragToDismiss(open, sheet, list, close);
  const selected = options.find((option) => option.value === value);

  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`${field} flex items-center justify-between gap-3 text-start`}
      >
        <span className="truncate">{selected?.label ?? ""}</span>
        <span aria-hidden="true" className="text-paper/45">
          ⌄
        </span>
      </button>
      {open && (
        <div data-hit="" className="fixed inset-0 z-[70] flex flex-col justify-end">
          <button
            type="button"
            aria-label={t("common.cancel")}
            onClick={close}
            className="absolute inset-0 bg-black/55"
          />
          <div
            ref={sheet}
            className="screen relative flex max-h-[70%] flex-col overflow-hidden rounded-t-3xl border-t border-hair bg-ink"
          >
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-paper/25"
            />
            <div className="flex items-center justify-between gap-3 py-2 ps-5 pe-3">
              <div className="min-w-0 truncate text-sm font-semibold text-paper/60">{label}</div>
              <button
                type="button"
                aria-label={t("common.cancel")}
                onClick={close}
                className="grid size-10 shrink-0 place-items-center rounded-full bg-paper/[0.08] text-paper/80 active:bg-paper/[0.16]"
              >
                <CloseIcon />
              </button>
            </div>
            <div
              ref={list}
              role="listbox"
              aria-label={label}
              className="divide-y divide-hair overflow-y-auto overscroll-contain pb-[calc(var(--safe-bottom)+12px)]"
            >
              {options.map((option) => {
                const active = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      close();
                      if (!active) onChange(option.value);
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-5 py-3.5 text-start text-base active:bg-paper/[0.08] ${
                      active ? "font-semibold text-accent" : "text-paper"
                    }`}
                  >
                    <span className="truncate">{option.label}</span>
                    {active && <CheckIcon />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
