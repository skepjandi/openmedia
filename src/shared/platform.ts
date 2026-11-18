/** True in the Android WebView. The shell uses it for Android-only system input and styling. */
export const isAndroid = (): boolean => /Android/i.test(navigator.userAgent);

/** True on iPhone and iPad, including iPadOS reporting a Mac user agent with a touch screen. */
export const isIos = (): boolean =>
  /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/**
 * True on Windows and Linux, which have no store: every feature is unlocked there and Rust
 * reports Pro from the first call. Case-sensitive so a test environment's lowercase "linux" does
 * not match; Android's user agent also says "Linux".
 */
export const isStorelessDesktop = (userAgent: string = navigator.userAgent): boolean =>
  /Windows NT|Linux/.test(userAgent) && !/Android/i.test(userAgent);
