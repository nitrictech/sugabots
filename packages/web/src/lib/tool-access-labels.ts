import type { ConnectionAccess } from "@sugabots/contracts";

/*
 * Plain data, which the native apps' copies are generated from. apps/codegen
 * loads this module with Node, so it imports nothing but types.
 */

/** What a tool's setting is called on a connection's own page: Allowed, Ask first, Off. */
export const TOOL_ACCESS_LABELS: Record<ConnectionAccess, string> = {
	allow: "Allowed",
	ask: "Ask first",
	off: "Off",
};
