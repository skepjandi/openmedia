import type { Rect } from "../shared/ipc";

/**
 * Sends the shell's interactive regions to native code, and only when they changed. Native code
 * answers every click outside them with "not the shell", so a set it never received leaves the
 * shell unclickable: a failed send is forgotten and the next one goes out even if nothing moved,
 * and `forget` makes the next one go out whatever was last sent.
 */
export function createRegionReporter(send: (regions: Rect[]) => Promise<unknown>) {
  let delivered = "";

  const report = (regions: Rect[]) => {
    const key = JSON.stringify(regions);
    if (key === delivered) return;
    delivered = key;
    send(regions).catch(() => {
      if (delivered === key) delivered = "";
    });
  };

  const forget = () => {
    delivered = "";
  };

  return { report, forget };
}
