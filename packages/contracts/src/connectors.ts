import { Schema, Struct } from "effect";
import { namedMemberSchema } from "./api.ts";
import { handleSchema } from "./bots.ts";
import {
	headerNameSchema,
	isClientOwnedHeader,
	providerStatusSchema,
	providerTestResultSchema,
	providerUrlSchema,
} from "./model-providers.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Connectors: the MCP servers, HTTP endpoints and GitHub app a bot uses.
 *
 * A connector is one bot's: a URL, a secret entered once and stored encrypted, or an
 * OAuth sign-in, and the tools the server was found to offer. The bot gets
 * those tools, as far as each tool's `access` allows. Remote servers over
 * Streamable HTTP only; nothing here spawns a process.
 */

/** A tool as the server described it when last asked. The text is the server's. */
const connectorToolSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	/** The server's own hints about the tool, when it gave them. */
	readOnly: Schema.NullOr(Schema.Boolean),
	destructive: Schema.NullOr(Schema.Boolean),
});

export type ConnectorTool = typeof connectorToolSchema.Type;

/**
 * An MCP server; a GitHub account the project's own GitHub App is installed
 * on, whose tools are Sugabots' own; or an HTTP endpoint, whose tools are a
 * request per method under its address.
 */
const connectorKindSchema = Schema.Literals(["mcp", "github", "http"]);
export type ConnectorKind = typeof connectorKindSchema.Type;

/**
 * How the server is signed in to. `header`: a secret someone who manages the
 * connector pasted, sent in a header. `oauth`: the server signed the project
 * in itself and issued tokens, which are refreshed as they expire.
 */
const connectorAuthSchema = Schema.Literals(["header", "oauth"]);
export type ConnectorAuth = typeof connectorAuthSchema.Type;

/**
 * What the bot may do with one of a connector's tools.
 *
 * - `allow`: each call runs straight away.
 * - `ask`: each call waits for a member to allow it.
 * - `off`: bots can't use the tool.
 */
export const connectorAccesses = ["off", "ask", "allow"] as const;
const connectorAccessSchema = Schema.Literals(connectorAccesses);
export type ConnectorAccess = typeof connectorAccessSchema.Type;

/** A connector's tool as the server described it, with what bots may do with it. */
const connectorToolWithAccessSchema = Schema.Struct({
	...connectorToolSchema.fields,
	access: connectorAccessSchema,
});
export type ConnectorToolWithAccess = typeof connectorToolWithAccessSchema.Type;

/**
 * A connector's tool as its settings show it: what the bot may do with
 * it, without the server's description, which can run to many kilobytes.
 */
const connectorToolSettingSchema = connectorToolWithAccessSchema.mapFields(
	Struct.omit(["description"]),
);
export type ConnectorToolSetting = typeof connectorToolSettingSchema.Type;

/** How many of a connector's tools are at each setting. */
const toolAccessCountsSchema = Schema.Struct({
	allow: Schema.Int,
	ask: Schema.Int,
	off: Schema.Int,
});
export type ToolAccessCounts = typeof toolAccessCountsSchema.Type;

/** How many of `tools` are at each setting. */
export function toolAccessCountsOf(
	tools: readonly Pick<ConnectorToolWithAccess, "access">[],
): ToolAccessCounts {
	const counts = { allow: 0, ask: 0, off: 0 };
	for (const tool of tools) counts[tool.access] += 1;
	return counts;
}

/**
 * Where an authorization server sends the browser back after a connector's
 * sign-in: an API path, under `API_BASE_PATH`.
 */
export const CONNECTOR_SIGN_IN_CALLBACK_PATH = "/connectors/oauth/callback";

/**
 * The web page a connector's OAuth sign-in returns to, with `workspace` and
 * `project` naming its project, and, when it did not finish, an `oauth_error`
 * code from {@link connectorSignInFailures}.
 */
export const CONNECTOR_SIGN_IN_RETURN_PATH = "/connectors/oauth/return";

/**
 * Why a sign-in did not finish, as the web app is told it. The web app words
 * each one itself, so nothing an authorization server sent back is shown.
 *
 * - `unknown_state`: no sign-in that this session can finish matches the callback.
 * - `refused`: the authorization server refused, or sent no code.
 * - `not_completed`: exchanging the code for tokens failed.
 */
export const connectorSignInFailures = ["unknown_state", "refused", "not_completed"] as const;
const connectorSignInFailureSchema = Schema.Literals(connectorSignInFailures);
export type ConnectorSignInFailure = typeof connectorSignInFailureSchema.Type;

/** The project a connector's sign-in was for, by its workspace and its own id. */
const signInProjectSchema = Schema.Struct({ workspaceId: uuidSchema, projectId: uuidSchema });

/**
 * How a connector's sign-in ended, for its callback to send the browser back
 * with. `at` names the project once the sign-in is known to be for one whose
 * connectors the caller manages.
 */
export const connectorSignInOutcomeSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("done"), at: signInProjectSchema }),
	Schema.Struct({
		kind: Schema.Literal("failed"),
		failure: connectorSignInFailureSchema,
		at: Schema.UndefinedOr(signInProjectSchema),
	}),
]);

export type ConnectorSignInOutcome = typeof connectorSignInOutcomeSchema.Type;

export const connectorSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	/** The project it belongs to; a bot's are its default project's. */
	projectId: uuidSchema,
	name: Schema.String,
	enabled: Schema.optional(Schema.Boolean),
	/** Prefixes the server's tool names for the model: `exa__web_search_exa`. */
	handle: handleSchema,
	kind: connectorKindSchema,
	/** The MCP server's address; for GitHub, the page of the account its app is installed on, or of the app until it is. */
	url: providerUrlSchema,
	auth: connectorAuthSchema,
	/**
	 * For `oauth`, whether the sign-in has been completed and tokens are held;
	 * for GitHub, whether its app is installed. Always true for `header`.
	 */
	signedIn: Schema.Boolean,
	/**
	 * For `oauth`, whether a turn found the sign-in refused, so it is not
	 * signed in until someone signs in again. Always false for `header`.
	 */
	signInExpired: Schema.Boolean,
	secretHeader: Schema.NullOr(Schema.String),
	hasSecret: Schema.Boolean,
	/** For GitHub, where the owner of the connector's app changes or deletes it; null otherwise. */
	appSettingsUrl: Schema.NullOr(Schema.String),
	status: providerStatusSchema,
	/**
	 * How many of the tools the server listed when last asked are at each
	 * setting. The tools themselves come with one connector, not the list,
	 * since a server can list hundreds.
	 */
	toolCounts: toolAccessCountsSchema,
	lastTestError: Schema.NullOr(Schema.String),
	/** Whoever added it, while they are still in the workspace. */
	connectedBy: Schema.NullOr(namedMemberSchema),
	/**
	 * The member it signs in as, while they are still in the workspace: who
	 * made its OAuth sign-in, or, for GitHub, who installed its app on their
	 * own GitHub account. Null for a key, or an app installed on an organization.
	 */
	signedInAs: Schema.NullOr(namedMemberSchema),
	createdAt: isoTimestampSchema,
});

export type Connector = typeof connectorSchema.Type;

const restrictableConnectorSchema = Schema.Struct({
	id: uuidSchema,
	name: Schema.String,
	enabled: Schema.Boolean,
	restricted: Schema.Literal(true),
});
export type RestrictableConnector = typeof restrictableConnectorSchema.Type;
export const connectorListItemSchema = Schema.Union([connectorSchema, restrictableConnectorSchema]);

/**
 * One of a project bot's own connectors, as the project's settings show it:
 * whether it is on in this project, where the bot may use it in the
 * project's chats. It is off until one of the project's managers turns it on.
 */
export const projectBotConnectorSchema = Schema.Struct({
	id: uuidSchema,
	name: Schema.String,
	kind: connectorKindSchema,
	/** Where the connector sends what the bot gives it. */
	url: Schema.String,
	botId: uuidSchema,
	botName: Schema.String,
	on: Schema.Boolean,
	/** Turned on before its address changed, which turned it off until it is turned on again. */
	addressChanged: Schema.Boolean,
});
export type ProjectBotConnector = typeof projectBotConnectorSchema.Type;

/** One connector with its tools, each with what bots may do with it. */
export const connectorWithToolsSchema = Schema.Struct({
	...connectorSchema.fields,
	tools: Schema.Array(connectorToolSettingSchema),
});
export type ConnectorWithTools = typeof connectorWithToolsSchema.Type;

const secretSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const connectorNameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64));
/**
 * The header the secret is sent in. `Authorization` is the usual one: a hosted
 * MCP server reads a bearer token or API key from it, and nothing else sets it
 * on a connector's requests. Only headers the client itself owns are refused.
 */
const secretHeaderSchema = headerNameSchema.check(
	Schema.makeFilter((name) => !isClientOwnedHeader(name), { message: "Header name is reserved" }),
);

const newMcpConnectorSchema = Schema.Struct({
	kind: Schema.optional(Schema.Literal("mcp")),
	name: connectorNameSchema,
	url: providerUrlSchema,
	/** `oauth` to sign in through the server; the secret fields are then ignored. */
	auth: Schema.optional(connectorAuthSchema),
	/** The header the server reads a secret from, when it takes one. */
	secretHeader: Schema.optional(secretHeaderSchema),
	secret: Schema.optional(secretSchema),
});

/** An HTTP endpoint: requests go under `url`, with the secret, when there is one, in `secretHeader`. */
const newHttpConnectorSchema = Schema.Struct({
	kind: Schema.Literal("http"),
	name: connectorNameSchema,
	url: providerUrlSchema,
	secretHeader: Schema.optional(secretHeaderSchema),
	secret: Schema.optional(secretSchema),
});

/** An MCP server when `kind` is absent. */
export const newConnectorSchema = Schema.Union([newMcpConnectorSchema, newHttpConnectorSchema]);

export type NewConnector = typeof newConnectorSchema.Type;

/** A server's address and secret, to test before a connector is made with them. */
export const unsavedConnectorSchema = Schema.Struct({
	url: providerUrlSchema,
	secretHeader: Schema.optional(secretHeaderSchema),
	secret: Schema.optional(secretSchema),
});

export type UnsavedConnector = typeof unsavedConnectorSchema.Type;

/** Making a built-in connector and starting its sign-in, as one request. */
export const connectBuiltInSchema = Schema.Struct({
	name: connectorNameSchema,
	url: providerUrlSchema,
});
export const connectBuiltInResultSchema = Schema.Struct({
	connectorId: uuidSchema,
	authorizationUrl: Schema.String,
});

/** Where the browser goes to sign in, or nothing when the connector is already signed in. */
export const connectorOauthStartSchema = Schema.Struct({
	authorizationUrl: Schema.NullOr(Schema.String),
});

export const connectorUpdateSchema = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
	name: Schema.optional(connectorNameSchema),
	url: Schema.optional(providerUrlSchema),
	/** Absent leaves the header alone; null means the server takes no secret. */
	secretHeader: Schema.optional(Schema.NullOr(secretHeaderSchema)),
	/**
	 * Absent leaves the stored secret alone, unless `url` moves the connector,
	 * which takes away its secret and OAuth sign-in; null removes it.
	 */
	secret: Schema.optional(Schema.NullOr(secretSchema)),
	/** Sets every tool the connector lists. */
	access: Schema.optional(connectorAccessSchema),
	/** Sets the tools named, by the server's name for each. Every name must be one the connector lists. */
	toolAccess: Schema.optional(
		Schema.Record(
			Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
			connectorAccessSchema,
		).check(Schema.isMaxProperties(1_000)),
	),
}).check(
	Schema.makeFilter((value) => Object.keys(value).length > 0, { message: "Nothing to change" }),
	Schema.makeFilter((value) => value.access === undefined || value.toolAccess === undefined, {
		message: "Set every tool or the tools named, not both",
	}),
);

export type ConnectorUpdate = typeof connectorUpdateSchema.Type;

export const connectorTestResultSchema = Schema.Struct({
	...providerTestResultSchema.fields,
	/** How many tools the server listed, when it answered. */
	tools: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type ConnectorTestResult = typeof connectorTestResultSchema.Type;

/**
 * Whether a tool may change something at the other end: anything the server
 * has not marked read-only, which is also the spec's default for a tool that
 * says nothing. `destructiveHint` plays no part. In the spec it only tells an
 * overwriting change from an additive one, and an additive change is still a
 * change: counting it as a read offered Linear's `create_issue_label` on a
 * read-only connector, without asking. This is a tool call's `writeOrDelete` flag: a
 * failed turn after such a call is not retried on its own.
 */
export function connectorToolWritesOrDeletes(tool: Pick<ConnectorTool, "readOnly">) {
	return tool.readOnly !== true;
}

/**
 * Between a connector's handle and a tool's name in the key the model calls:
 * `linear__list_issues`. Two underscores rather than a dot because providers
 * only take letters, digits, `_` and `-` in a tool name, and a handle never
 * contains two underscores, so the key splits back without ambiguity.
 */
export const CONNECTOR_TOOL_SEPARATOR = "__";

export function connectorToolKey(handle: string, toolName: string): string {
	return `${handle}${CONNECTOR_TOOL_SEPARATOR}${toolName}`;
}

/**
 * A built-in connector: a hosted MCP server Sugabots ships settings for, which signs a
 * workspace in through its own OAuth and registers clients on its own, so
 * connecting is one click with nothing to set up. That is the whole test for
 * being listed; adding a server is this record and its mark.
 */
export interface BuiltInConnector {
	id: string;
	name: string;
	/** One line on what its tools reach. */
	description: string;
	url: string;
}

export const builtInConnectors: readonly BuiltInConnector[] = [
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
	{
		id: "suga",
		name: "Suga",
		description: "Projects, environments and deployments",
		url: "https://dashboard.suga.app/api/mcp",
	},
];

/** The built-in connector a connector was made from, by its address, if any. */
export function builtInConnectorFor(url: string): BuiltInConnector | undefined {
	const host = hostOf(url);
	return host ? builtInConnectors.find((builtIn) => hostOf(builtIn.url) === host) : undefined;
}

/**
 * The mark a connector is drawn with: GitHub's for a GitHub connector, a
 * built-in connector's for its server, and none, so its letters, for any other.
 */
export function connectorMarkFor(connector: { kind: ConnectorKind; url: string }) {
	return connector.kind === "github" ? "github" : builtInConnectorFor(connector.url)?.id;
}

/** The host of an address, without `URL`, which the contracts run without a DOM for. */
function hostOf(url: string): string | undefined {
	return /^https?:\/\/([^/?#]+)/i.exec(url)?.[1]?.toLowerCase();
}

/** The two letters a connector that is no built-in connector is drawn with. */
export function connectorLetters(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const letters =
		words.length >= 2
			? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
			: (words[0] ?? "?").slice(0, 2);
	return letters.toUpperCase();
}
