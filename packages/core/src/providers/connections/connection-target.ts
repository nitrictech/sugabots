import type { ToolAccess } from "../../database/schema.ts";

/** What it takes to call a connection's server: where, and with which headers. */
export interface ConnectionTarget {
	connectionId: string;
	handle: string;
	url: string;
	/** `oauth` calls carry no header of ours: the SDK adds the tokens it holds. */
	auth: "header" | "oauth";
	headers: Record<string, string>;
	/** What somebody chose for the pod's bots to do with each tool; see `toolAccessOf`. */
	toolAccess: ToolAccess;
	/** So a test result is recorded against the configuration it tested. */
	configurationUpdatedAt: Date;
	configurationRevision: number;
}
