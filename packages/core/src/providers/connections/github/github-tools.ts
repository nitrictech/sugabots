import type { ConnectionTool } from "@sugabots/contracts";

/**
 * A GitHub connection's tools, which are Sugabots' own: every GitHub
 * connection has this version's, so people choose what bots may do with
 * each, and new ones reach connections made before them. Those that change
 * something wait for a person until someone chooses otherwise.
 */
export const GITHUB_CONNECTION_TOOLS: readonly ConnectionTool[] = [];
