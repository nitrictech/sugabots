import type { ConnectorAccess } from "@sugabots/contracts";

/** What a tool's setting is called on a connector's own page: Allowed, Ask first, Off. */
export const TOOL_ACCESS_LABELS: Record<ConnectorAccess, string> = {
	allow: "Allowed",
	ask: "Ask first",
	off: "Off",
};
