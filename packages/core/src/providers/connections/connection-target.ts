import type { ConnectionAccess } from "@sugabots/contracts";

/** What it takes to call a connection's server: where, and with which headers. */
export interface ConnectionTarget {
	connectionId: string;
	handle: string;
	url: string;
	/** `oauth` calls carry no header of ours: the SDK adds the tokens it holds. */
	auth: "header" | "oauth";
	headers: Record<string, string>;
	/** What the pod's bots may do with its tools. */
	access: ConnectionAccess;
	/** So a test result is recorded against the configuration it tested. */
	configurationUpdatedAt: Date;
	configurationRevision: number;
}
