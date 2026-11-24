/** Whether the browser is on a Mac, where shortcuts are written and read with ⌘ and Option, not Ctrl and Alt. */
export const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
