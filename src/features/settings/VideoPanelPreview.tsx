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
          className="absolute inset-x-3 flex items-center justify-between rounded-full bg-black/60 px-3 py-1.5 text-[10px] font-semibold text-white transition-[bottom] duration-200"
          style={{ bottom: panelBottom }}
        >
          <span>1×</span>
          <span>HD</span>
          <span>CC</span>
        </div>
      )}
    </div>
  );
}
