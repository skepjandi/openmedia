import { create } from "zustand";
import type { Side } from "../tiling/layout";

interface PaletteStore {
  open: boolean;
  /** Set while the palette asks which page goes in a new window on that side; null for the action list. */
  side: Side | null;
  setOpen: (open: boolean) => void;
  /** Opens the palette on the page picker for a window to be added on `side`. */
  pickPage: (side: Side) => void;
}

/** Whether the command palette is on screen, and which of its two lists. */
export const usePalette = create<PaletteStore>((set) => ({
  open: false,
  side: null,
  setOpen: (open) => set({ open, side: null }),
  pickPage: (side) => set({ open: true, side }),
}));
