import type { VideoControls } from "../../shared/ipc";

/** Phone screens are about this many times taller than the preview; the panel's height scales with it. */
const SCALE = 0.5;

/**
 * A sketch of a full-screen video feed with the controls panel where the settings put it: the
 * panel rides higher or lower as its height changes, and is gone when it is off.
 */
export function VideoPanelPreview({ value }: { value: VideoControls }) {
  const panelBottom = 12 + value.height * SCALE;
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto aspect-[9/16] w-full overflow-hidden rounded-2xl border border-hair bg-gradient-to-b from-paper/[0.12] to-paper/[0.03]"
    >
      <div className="absolute end-2.5 bottom-24 flex flex-col gap-3">
        {[0, 1, 2].map((dot) => (
          <span key={dot} className="size-6 rounded-full bg-paper/20" />
        ))}
      </div>
      <div
        className="absolute inset-x-3 flex flex-col gap-1.5 transition-[bottom] duration-200"
        style={{ bottom: panelBottom + 36 }}
      >
        <span className="h-1.5 w-2/3 rounded-full bg-paper/25" />
        <span className="h-1.5 w-1/2 rounded-full bg-paper/15" />
      </div>
      {value.panel && (
        <div
          className="absolute inset-x-2 flex flex-col gap-2 rounded-2xl bg-black/65 p-2.5 text-[9px] font-semibold text-white transition-[bottom] duration-200"
          style={{ bottom: panelBottom }}
        >
          <div className="flex items-center justify-between">
            <span className="size-3.5 rounded-sm border border-white/70" />
            <span className="size-3.5 rounded-sm border-2 border-white/70" />
          </div>
          <div className="flex items-center justify-center gap-3">
            <span className="grid size-6 place-items-center rounded-full bg-white/20">
              {value.skip}
            </span>
            <span className="grid size-9 place-items-center rounded-full bg-white text-[10px] text-black">
              ❚❚
            </span>
            <span className="grid size-6 place-items-center rounded-full bg-white/20">
              {value.skip}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span>0:42</span>
            <span className="relative h-1 flex-1 rounded-full bg-white/20">
              <span className="absolute inset-y-0 start-0 w-2/3 rounded-full bg-white/40" />
              <span className="absolute inset-y-0 start-0 w-1/3 rounded-full bg-white" />
              <span className="absolute start-1/3 top-1/2 size-2 -translate-y-1/2 rounded-full bg-white" />
            </span>
            <span>-1:18</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-sm bg-white/70" />
            <span className="h-1 w-8 rounded-full bg-white/25">
              <span className="block h-full w-2/3 rounded-full bg-white" />
            </span>
            <span className="ms-auto flex items-center gap-1.5">
              <span className="rounded-sm border border-white/60 px-0.5">CC</span>
              <span className="rounded-sm border border-white/60 px-0.5">HD</span>
            </span>
            <span className="rounded-full bg-white/20 px-1.5 py-0.5">1×</span>
          </div>
        </div>
      )}
    </div>
  );
}
