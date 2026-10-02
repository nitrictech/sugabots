import type { ConnectionAccess } from "@sugabots/contracts";

/** What it takes to call a connection's server: where, and with which headers. */
export interface ConnectionTarget {
	connectionId: string;
	handle: string;
	url: string;
	/** `oauth` calls carry no header of ours: the SDK adds the tokens it holds. */
	auth: "header" | "oauth";
	/** What the connection sends to authenticate, which picks the wording of an authentication failure. */
	credential: ConnectionCredential;
	headers: Record<string, string>;
	/** What the pod's bots may do with its tools. */
	access: ConnectionAccess;
	/** So a test result is recorded against the configuration it tested. */
	configurationUpdatedAt: Date;
	configurationRevision: number;
}

/**
 * How a connection authenticates to its server: an OAuth sign-in, an access
 * token sent as `Authorization: Bearer <token>`, a secret sent as typed in a
 * custom header, or nothing.
 */
export type ConnectionCredential = "oauth" | "token" | "header" | "none";
