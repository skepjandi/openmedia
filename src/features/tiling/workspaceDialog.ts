import { create } from "zustand";

interface WorkspaceDialog {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Whether the box that names the windows being saved is on screen. */
export const useWorkspaceDialog = create<WorkspaceDialog>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
