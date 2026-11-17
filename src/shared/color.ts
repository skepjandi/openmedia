/** `#rrggbb` as `[r, g, b]`, or null when the text is not that. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return null;
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

/** `#rrggbb` as CSS `rgb(r, g, b)`, or null when the text is not a hex color. */
export function hexToRgbText(hex: string): string | null {
  const rgb = hexToRgb(hex);
  return rgb && `rgb(${rgb.join(", ")})`;
}
