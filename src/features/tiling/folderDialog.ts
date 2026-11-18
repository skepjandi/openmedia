import { create } from "zustand";

interface FolderDialog {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Whether the box that names the windows being saved is on screen. */
export const useFolderDialog = create<FolderDialog>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
