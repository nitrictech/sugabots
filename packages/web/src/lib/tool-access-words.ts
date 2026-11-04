import type { ConnectionAccess } from "@sugabots/contracts";

/**
 * A tool's setting in words, as a connection's own page puts it: Allowed, Ask
 * first, Off. Plain data, which the native apps' copies are generated from.
 */
export const ACCESS_WORDS: Record<ConnectionAccess, string> = {
	allow: "Allowed",
	ask: "Ask first",
	off: "Off",
};
