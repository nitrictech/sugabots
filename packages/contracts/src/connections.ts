import { Schema } from "effect";
import { handleSchema } from "./agents.ts";
import {
	headerNameSchema,
	isClientOwnedHeader,
	providerStatusSchema,
	providerUrlSchema,
} from "./model-providers.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Connections: MCP servers a pod owner has configured for every agent in the pod.
 *
 * A connection is the workspace's: a URL, a secret entered once and sealed or
 * an OAuth sign-in, and the tools the server was found to offer. Every bot in
 * the pod gets those tools, as far as each tool's `access` allows. Remote
 * servers over Streamable HTTP only; nothing here spawns a process.
 */

/** A tool as the server described it when last asked. The text is the server's. */
export const connectionToolSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	/** The server's own hints about the tool, when it gave them. */
	readOnly: Schema.NullOr(Schema.Boolean),
	destructive: Schema.NullOr(Schema.Boolean),
});

export type ConnectionTool = typeof connectionToolSchema.Type;

/**
 * How the server is signed in to. `header`: a secret the admin pasted, sent in
 * a header. `oauth`: the server signed the workspace in itself and issued
 * tokens, which are refreshed as they expire.
 */
export const connectionAuthSchema = Schema.Literals(["header", "oauth"]);
export type ConnectionAuth = typeof connectionAuthSchema.Type;

/**
 * What the pod's bots may do with one of a connection's tools.
 *
 * - `allow`: each call runs straight away.
 * - `ask`: each call waits for a person to allow it.
 * - `off`: bots can't use the tool.
 */
export const connectionAccesses = ["off", "ask", "allow"] as const;
export const connectionAccessSchema = Schema.Literals(connectionAccesses);
export type ConnectionAccess = typeof connectionAccessSchema.Type;

/** A connection's tool as the server described it, with what the pod's bots may do with it. */
export const connectionToolWithAccessSchema = Schema.Struct({
	...connectionToolSchema.fields,
	access: connectionAccessSchema,
});
export type ConnectionToolWithAccess = typeof connectionToolWithAccessSchema.Type;

/**
 * Where an authorization server sends the browser back after a connection's
 * sign-in: an API path, under `API_BASE_PATH`.
 */
export const CONNECTION_SIGN_IN_CALLBACK_PATH = "/connections/oauth/callback";

/**
 * The web page a connection's OAuth sign-in returns to, with the pod's ids
 * and, when it did not finish, an `oauth_error` code from
 * {@link connectionSignInFailures}.
 */
export const CONNECTION_SIGN_IN_RETURN_PATH = "/connections/oauth/return";

/**
 * Why a sign-in did not finish, as the web app is told it. The web app words
 * each one itself, so nothing an authorization server sent back is shown.
 *
 * - `missing_state`: the callback carried no `state`.
 * - `unknown_state`: no connection is waiting on that `state`.
 * - `not_allowed`: the person may no longer manage the pod's connections.
 * - `refused`: the authorization server refused, or sent no code.
 * - `not_completed`: exchanging the code for tokens failed.
 */
export const connectionSignInFailures = [
	"missing_state",
	"unknown_state",
	"not_allowed",
	"refused",
	"not_completed",
] as const;
export const connectionSignInFailureSchema = Schema.Literals(connectionSignInFailures);
export type ConnectionSignInFailure = typeof connectionSignInFailureSchema.Type;

export const connectionSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	podId: uuidSchema,
	name: Schema.String,
	/** Prefixes the server's tool names for the model: `exa.web_search_exa`. */
	handle: handleSchema,
	url: providerUrlSchema,
	auth: connectionAuthSchema,
	/** For `oauth`, whether the sign-in has been completed and tokens are held. Always true for `header`. */
	signedIn: Schema.Boolean,
	secretHeader: Schema.NullOr(Schema.String),
	hasSecret: Schema.Boolean,
	status: providerStatusSchema,
	/** The tools the server listed when last asked, each with what the pod's bots may do with it. */
	tools: Schema.mutable(Schema.Array(connectionToolWithAccessSchema)),
	lastTestedAt: Schema.NullOr(isoTimestampSchema),
	lastTestError: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
});

export type Connection = typeof connectionSchema.Type;

const secretSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const connectionNameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64));
/**
 * The header the secret is sent in. `Authorization` is the usual one: a hosted
 * MCP server reads a bearer token or API key from it, and nothing else sets it
 * on a connection's requests. Only headers the client itself owns are refused.
 */
const secretHeaderSchema = headerNameSchema.check(
	Schema.makeFilter((name) => !isClientOwnedHeader(name), { message: "Header name is reserved" }),
);

export const newConnectionSchema = Schema.Struct({
	name: connectionNameSchema,
	url: providerUrlSchema,
	/** `oauth` to sign in through the server; the secret fields are then ignored. */
	auth: Schema.optional(connectionAuthSchema),
	/** The header the server reads a secret from, when it takes one. */
	secretHeader: Schema.optional(secretHeaderSchema),
	secret: Schema.optional(secretSchema),
});

export type NewConnection = typeof newConnectionSchema.Type;

/** A server's address and secret, to test before a connection is made with them. */
export const unsavedConnectionSchema = Schema.Struct({
	url: providerUrlSchema,
	secretHeader: Schema.optional(secretHeaderSchema),
	secret: Schema.optional(secretSchema),
});

export type UnsavedConnection = typeof unsavedConnectionSchema.Type;

/** Making a connection from the catalog and starting its sign-in, as one request. */
export const connectFromCatalogSchema = Schema.Struct({
	name: connectionNameSchema,
	url: providerUrlSchema,
});
export const connectFromCatalogResultSchema = Schema.Struct({
	connectionId: uuidSchema,
	authorizationUrl: Schema.String,
});
export type ConnectFromCatalogResult = typeof connectFromCatalogResultSchema.Type;

/** Where the browser goes to sign in, or nothing when the connection is already signed in. */
export const connectionOauthStartSchema = Schema.Struct({
	authorizationUrl: Schema.NullOr(Schema.String),
});
export type ConnectionOauthStart = typeof connectionOauthStartSchema.Type;

export const connectionUpdateSchema = Schema.Struct({
	name: Schema.optional(connectionNameSchema),
	url: Schema.optional(providerUrlSchema),
	/** Absent leaves the header alone; null means the server takes no secret. */
	secretHeader: Schema.optional(Schema.NullOr(secretHeaderSchema)),
	/** Absent leaves the stored secret alone; null removes it. */
	secret: Schema.optional(Schema.NullOr(secretSchema)),
	/** Sets the tools named, by the server's name for each. Every name must be one the connection lists. */
	toolAccess: Schema.optional(Schema.Record(Schema.String, connectionAccessSchema)),
}).check(
	Schema.makeFilter((value) => Object.keys(value).length > 0, { message: "Nothing to change" }),
);

export type ConnectionUpdate = typeof connectionUpdateSchema.Type;

export const connectionTestResultSchema = Schema.Struct({
	reachable: Schema.Boolean,
	latencyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** How many tools the server listed, when it answered. */
	tools: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	error: Schema.optional(Schema.String),
});

export type ConnectionTestResult = typeof connectionTestResultSchema.Type;

/**
 * Whether a tool may change something at the other end: anything the server
 * has not marked read-only, which is also the spec's default for a tool that
 * says nothing. `destructiveHint` plays no part. In the spec it only tells an
 * overwriting change from an additive one, and an additive change is still a
 * change: counting it as a read offered Linear's `create_issue_label` on a
 * read-only connection, without asking. This is a tool call's `mutating` flag: a
 * failed turn after such a call is not retried on its own.
 */
export function connectionToolMutating(tool: Pick<ConnectionTool, "readOnly">) {
	return tool.readOnly !== true;
}

/**
 * Between a connection's handle and a tool's name in the key the model calls:
 * `linear__list_issues`. Two underscores rather than a dot because providers
 * only take letters, digits, `_` and `-` in a tool name, and a handle never
 * contains two underscores, so the key splits back without ambiguity.
 */
export const CONNECTION_TOOL_SEPARATOR = "__";

export function connectionToolKey(handle: string, toolName: string): string {
	return `${handle}${CONNECTION_TOOL_SEPARATOR}${toolName}`;
}

/**
 * One entry in the connections catalog: a hosted MCP server that signs a
 * workspace in through its own OAuth and registers clients on its own, so
 * connecting is one click with nothing to set up. That is the whole test for
 * being listed; adding a server is this record and its mark.
 */
export interface ConnectionPreset {
	id: string;
	name: string;
	/** One line on what its tools reach. */
	description: string;
	url: string;
}

export const connectionCatalog: readonly ConnectionPreset[] = [
	{
		id: "linear",
		name: "Linear",
		description: "Issues, projects and cycles",
		url: "https://mcp.linear.app/mcp",
	},
	{
		id: "stripe",
		name: "Stripe",
		description: "Customers, payments and invoices",
		url: "https://mcp.stripe.com",
	},
	{
		id: "notion",
		name: "Notion",
		description: "Pages and databases",
		url: "https://mcp.notion.com/mcp",
	},
	{
		id: "sentry",
		name: "Sentry",
		description: "Errors and performance issues",
		url: "https://mcp.sentry.dev/mcp",
	},
	{
		id: "jira",
		name: "Jira",
		description: "Issues and boards",
		url: "https://mcp.atlassian.com/v1/mcp",
	},
];

/** The catalog entry a connection was made from, by its address, if any. */
export function connectionPresetFor(url: string): ConnectionPreset | undefined {
	const host = hostOf(url);
	return host ? connectionCatalog.find((preset) => hostOf(preset.url) === host) : undefined;
}

/** The host of an address, without `URL`, which the contracts run without a DOM for. */
function hostOf(url: string): string | undefined {
	return /^https?:\/\/([^/?#]+)/i.exec(url)?.[1]?.toLowerCase();
}

/** The two letters a connection with no catalog entry is drawn with. */
export function connectionLetters(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const letters =
		words.length >= 2
			? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
			: (words[0] ?? "?").slice(0, 2);
	return letters.toUpperCase();
}
