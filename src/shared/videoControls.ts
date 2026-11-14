import type { VideoControls } from "./ipc";

/** Everything off: what the app starts with, and what Rust holds until the user chooses. */
export const VIDEO_CONTROLS_OFF: VideoControls = {
  seekBar: false,
  speed: false,
  remember: false,
  loopOff: false,
  autoAdvance: false,
};
