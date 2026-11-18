import { create } from "zustand";

interface PaletteStore {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Whether the command palette is on screen. */
export const usePalette = create<PaletteStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
