import { useEffect } from "react";
import type { Accessibility } from "./ipc";

/** Everything off: what the app starts with, and what Rust holds until the user chooses. */
export const ACCESSIBILITY_OFF: Accessibility = {
  epilepsyProtection: false,
  font: "off",
  spacing: false,
  tint: "off",
};

const ATTRIBUTES = ["data-calm", "data-reading-font", "data-wide-text"];

/** What `index.css` reads from `<html>`. The tint is drawn on pages only, so it is not here. */
export function accessibilityAttributes(accessibility: Accessibility): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (accessibility.epilepsyProtection) attributes["data-calm"] = "";
  if (accessibility.font !== "off") attributes["data-reading-font"] = accessibility.font;
  if (accessibility.spacing) attributes["data-wide-text"] = "";
  return attributes;
}

/** Keeps the app's own screens in step with the choices the pages get through Rust. */
export function useApplyAccessibility(accessibility: Accessibility) {
  const key = JSON.stringify(accessibilityAttributes(accessibility));
  useEffect(() => {
    const root = document.documentElement;
    const attributes = JSON.parse(key) as Record<string, string>;
    for (const name of ATTRIBUTES) root.removeAttribute(name);
    for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
  }, [key]);
}
