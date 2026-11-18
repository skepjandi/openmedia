import type { PageScroll } from "../../shared/ipc";

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "radio",
  "range",
  "submit",
  "reset",
  "color",
  "file",
]);

/** Whether a key press would type into this element. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return target instanceof HTMLTextAreaElement || target.isContentEditable;
}

const FOCUSABLE =
  'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [role="button"], [role="switch"]';

/** Controls on screen right now: visible, enabled, and not covered by a page drawn on top. */
function reachableControls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
    if (element.matches(":disabled")) return false;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const x = Math.min(Math.max(box.left + box.width / 2, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(box.top + box.height / 2, 0), window.innerHeight - 1);
    const top = document.elementFromPoint(x, y);
    return top !== null && (element.contains(top) || top.contains(element));
  });
}

function focusControl(element: HTMLElement | undefined): void {
  element?.focus();
  element?.scrollIntoView({ block: "nearest" });
}

/** Moves the keyboard focus to the next (1) or previous (-1) control of the page on top. */
export function moveFocus(step: 1 | -1): void {
  const controls = reachableControls();
  if (controls.length === 0) return;
  const current = controls.findIndex((element) => element === document.activeElement);
  if (current === -1) {
    focusControl(step === 1 ? controls[0] : controls[controls.length - 1]);
    return;
  }
  focusControl(controls[(current + step + controls.length) % controls.length]);
}

export function focusEdge(edge: "first" | "last"): void {
  const controls = reachableControls();
  focusControl(edge === "first" ? controls[0] : controls[controls.length - 1]);
}

/** Clicks the control that has the keyboard focus. */
export function activateFocused(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.click();
}

/** The scrolling area of the page on top: the nearest scrollable ancestor of what is mid-screen. */
function scrollArea(): HTMLElement | null {
  let element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  while (element instanceof HTMLElement) {
    const overflow = getComputedStyle(element).overflowY;
    if (/(auto|scroll)/.test(overflow) && element.scrollHeight > element.clientHeight + 1) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

const LINE = 60;

/** Scrolls the page on top of the shell (Settings, History and the like) the way the page's is scrolled. */
export function scrollSheet(scroll: PageScroll): void {
  const area = scrollArea();
  if (!area) return;
  const screen = area.clientHeight * 0.9;
  switch (scroll) {
    case "down":
      return area.scrollBy({ top: LINE });
    case "up":
      return area.scrollBy({ top: -LINE });
    case "halfDown":
      return area.scrollBy({ top: area.clientHeight / 2 });
    case "halfUp":
      return area.scrollBy({ top: -area.clientHeight / 2 });
    case "pageDown":
      return area.scrollBy({ top: screen });
    case "pageUp":
      return area.scrollBy({ top: -screen });
    case "top":
      return area.scrollTo({ top: 0 });
    case "bottom":
      return area.scrollTo({ top: area.scrollHeight });
    default:
      return;
  }
}
