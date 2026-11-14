/** True in the Android WebView. The shell uses it for Android-only system input and styling. */
export const isAndroid = (): boolean => /Android/i.test(navigator.userAgent);

/** True on iPhone and iPad, including iPadOS reporting a Mac user agent with a touch screen. */
export const isIos = (): boolean =>
  /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
