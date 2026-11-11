/*
 * How a bot-made page is framed in the app, as plain data, which the native
 * apps' copies are generated from. apps/codegen loads this module with Node,
 * so it imports nothing but types.
 */

/** How tall a frame fitted to its page may be before it is clipped, so one page never takes over a conversation. */
export const FIT_HEIGHT_PX = { min: 120, max: 560 } as const;

/**
 * The app's tokens a page is given as CSS variables of the same names, which
 * the artifact tools tell bots about. Each is copied as the stylesheet
 * declares it, `light-dark()` and all, so it follows the frame's
 * `color-scheme`, which is the app's.
 */
export const FRAME_TOKENS = [
	"--background",
	"--card",
	"--panel",
	"--chip",
	"--hover",
	"--foreground",
	"--body-foreground",
	"--muted-foreground",
	"--subtle-foreground",
	"--border",
	"--border-strong",
	"--primary",
	"--primary-foreground",
	"--link",
	"--success-text",
	"--destructive-text",
	"--warning",
	"--font-sans",
	"--font-mono",
] as const;
