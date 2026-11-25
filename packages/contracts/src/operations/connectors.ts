/**
 * The connectors operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import {
	connectBuiltInResultSchema,
	connectBuiltInSchema,
	connectorListItemSchema,
	connectorOauthStartSchema,
	connectorSchema,
	connectorSignInOutcomeSchema,
	connectorTestResultSchema,
	connectorUpdateSchema,
	connectorWithToolsSchema,
	newConnectorSchema,
	unsavedConnectorSchema,
} from "../connectors.ts";
import {
	ConnectorDoesNotUseOAuth,
	ConnectorNameTaken,
	ConnectorNeededNoSignIn,
	ConnectorNotFound,
	ConnectorOAuthStartFailed,
	GitHubAppNotInstalled,
	GitHubRequestFailed,
	NotGitHubConnector,
	ProjectHasGitHubConnector,
	RepositoryUnreachable,
	UnknownConnectorTool,
} from "../errors/connectors.ts";
import {
	ActionForbidden,
	ApprovalNeeded,
	ApprovalRefused,
	BotCannotReach,
	ResourceHidden,
	TurnEnded,
} from "../errors/proofs.ts";
import { UrlNotAllowed } from "../errors/providers.ts";
import { TurnExecutionSuperseded } from "../errors/turns.ts";
import {
	accountRepositorySchema,
	connectorRepositoriesSchema,
	connectorRepositoryChangeSchema,
	deliveredActivitySchema,
	gitHubAppFormSchema,
	gitHubAppInstallSchema,
	gitHubSetupOutcomeSchema,
	newGitHubAppSchema,
} from "../github.ts";
import { uuidSchema } from "../uuid.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

/**
 * How an operation that proves it reaches a project, and may read or manage
 * its connectors, refuses.
 */
const refusals = [ResourceHidden, BotCannotReach, ActionForbidden] as const;

/** A project, by its id. */
const aProject = Schema.Struct({ projectId: uuidSchema });

/** One of a project's connectors, by the project's id and its own. */
const aConnector = Schema.Struct({ projectId: uuidSchema, connectorId: uuidSchema });

export const TOOL_SEARCH = "tool_search";

export const connectorsContracts = {
	"connectors.searchTools": OperationContract.make("connectors.searchTools", {
		description:
			"Find tools your connectors provide. Give a few words for what you want to do, a connector's name, or a tool's full name. The best matches include their input schema. Then run one with call_tool. If nothing matches, try other words before telling the member it can't be done.",
		input: Schema.Struct({
			query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
				description: "What you want to do, such as 'list open issues', or a tool's full name",
			}),
		}),
		output: Schema.Unknown,
		errors: [...refusals, ApprovalNeeded, ApprovalRefused, TurnEnded],
		changes: false,
	}),
	"connectors.callTool": OperationContract.make("connectors.callTool", {
		description: "Call a connector tool found by tool_search, with the arguments its schema takes.",
		input: Schema.Struct({
			connectorId: uuidSchema,
			tool: Schema.String.check(Schema.isMinLength(1)),
			arguments: Schema.Record(Schema.String, Schema.Unknown),
		}),
		output: Schema.Unknown,
		errors: [...refusals, ApprovalNeeded, ApprovalRefused, TurnEnded, TurnExecutionSuperseded],
		changes: true,
	}),
	"connectors.list": OperationContract.make("connectors.list", {
		description:
			"List a project's connectors, with how many of each one's tools are at each access.",
		input: aProject,
		output: Schema.Array(connectorListItemSchema),
		errors: refusals,
		changes: false,
	}),
	"connectors.create": OperationContract.make("connectors.create", {
		description:
			"Connect a project to an MCP server or an HTTP endpoint. A server that signs in with a key, or none, is asked for its tools straight away.",
		input: Schema.Struct({ projectId: uuidSchema, connector: newConnectorSchema }),
		output: connectorSchema,
		errors: [...refusals, UrlNotAllowed, ConnectorNameTaken, ConnectorNotFound],
		changes: true,
	}),
	"connectors.testUnsaved": OperationContract.make("connectors.testUnsaved", {
		description:
			"Ask the MCP server at an address, with its key, for its tools, before a connector is made with them. Nothing is saved.",
		input: Schema.Struct({ projectId: uuidSchema, ...unsavedConnectorSchema.fields }),
		output: connectorTestResultSchema,
		errors: [...refusals, UrlNotAllowed],
		changes: false,
	}),
	"connectors.get": OperationContract.make("connectors.get", {
		description: "Show one of a project's connectors, with each of its tools' access.",
		input: aConnector,
		output: connectorWithToolsSchema,
		errors: [...refusals, ConnectorNotFound],
		changes: false,
	}),
	"connectors.update": OperationContract.make("connectors.update", {
		description:
			"Change a connector's name, address, key or tool access. A new address or key asks its server for its tools again.",
		input: Schema.Struct({
			projectId: uuidSchema,
			connectorId: uuidSchema,
			changes: connectorUpdateSchema,
		}),
		output: connectorListItemSchema,
		errors: [
			...refusals,
			ConnectorNotFound,
			UrlNotAllowed,
			ConnectorNameTaken,
			UnknownConnectorTool,
		],
		changes: true,
	}),
	"connectors.remove": OperationContract.make("connectors.remove", {
		description: "Remove a connector from a project, with its key or sign-in.",
		input: aConnector,
		output: Schema.Void,
		errors: [...refusals, ConnectorNotFound],
		changes: true,
	}),
	"connectors.test": OperationContract.make("connectors.test", {
		description:
			"Ask a connector's MCP server for its tools, or check an HTTP endpoint's address without sending it anything, and record how it went.",
		input: aConnector,
		output: connectorTestResultSchema,
		errors: [...refusals, ConnectorNotFound],
		changes: true,
	}),
	"connectors.connectBuiltIn": OperationContract.make("connectors.connectBuiltIn", {
		description:
			"Connect a project to a built-in connector, which signs in with OAuth, and start its sign-in.",
		input: Schema.Struct({ projectId: uuidSchema, ...connectBuiltInSchema.fields }),
		output: connectBuiltInResultSchema,
		errors: [
			...refusals,
			UrlNotAllowed,
			ConnectorNameTaken,
			ConnectorOAuthStartFailed,
			ConnectorNeededNoSignIn,
		],
		changes: true,
	}),
	"connectors.startOAuth": OperationContract.make("connectors.startOAuth", {
		description:
			"Start signing a connector in with its server's OAuth: where to send the browser, or nothing when it is signed in already.",
		input: aConnector,
		output: connectorOauthStartSchema,
		errors: [...refusals, ConnectorNotFound, ConnectorDoesNotUseOAuth, ConnectorOAuthStartFailed],
		changes: true,
	}),
	"connectors.oauthCallback": OperationContract.make("connectors.oauthCallback", {
		description:
			"Finish a connector's OAuth sign-in with what its authorization server sent the browser back with, in the session that started it, while the member may still manage the project's connectors.",
		input: Schema.Struct({
			code: Schema.optional(Schema.String),
			state: Schema.optional(Schema.String),
			error: Schema.optional(Schema.String),
			errorDescription: Schema.optional(Schema.String),
		}),
		output: connectorSignInOutcomeSchema,
		errors: [],
		changes: true,
	}),
	"gitHubConnectors.start": OperationContract.make("gitHubConnectors.start", {
		description:
			"Start making a project's GitHub app, owned by a GitHub organization or by you: the form that asks GitHub to make it.",
		input: Schema.Struct({ projectId: uuidSchema, ...newGitHubAppSchema.fields }),
		output: gitHubAppFormSchema,
		errors: [...refusals, ProjectHasGitHubConnector],
		changes: false,
	}),
	"gitHubConnectors.installUrl": OperationContract.make("gitHubConnectors.installUrl", {
		description:
			"Where to install a project's GitHub app, or change which repositories it reaches.",
		input: aConnector,
		output: gitHubAppInstallSchema,
		errors: [...refusals, NotGitHubConnector],
		changes: false,
	}),
	"gitHubConnectors.reachableRepositories": OperationContract.make(
		"gitHubConnectors.reachableRepositories",
		{
			description:
				"List the repositories a project's GitHub app reaches on its account, to choose the project's from.",
			input: aConnector,
			output: Schema.Array(accountRepositorySchema),
			errors: [...refusals, NotGitHubConnector, GitHubAppNotInstalled, GitHubRequestFailed],
			changes: false,
		},
	),
	"gitHubConnectors.repositories": OperationContract.make("gitHubConnectors.repositories", {
		description:
			"List the repositories a project's bots work on through its GitHub app, and who added each.",
		input: aConnector,
		output: connectorRepositoriesSchema,
		errors: [...refusals, NotGitHubConnector],
		changes: false,
	}),
	"gitHubConnectors.addRepository": OperationContract.make("gitHubConnectors.addRepository", {
		description: "Add a repository the project's GitHub app reaches to those its bots work on.",
		input: Schema.Struct({
			projectId: uuidSchema,
			connectorId: uuidSchema,
			...connectorRepositoryChangeSchema.fields,
		}),
		output: connectorRepositoriesSchema,
		errors: [
			...refusals,
			NotGitHubConnector,
			GitHubAppNotInstalled,
			RepositoryUnreachable,
			GitHubRequestFailed,
		],
		changes: true,
	}),
	"gitHubConnectors.removeRepository": OperationContract.make("gitHubConnectors.removeRepository", {
		description: "Take a repository out of those the project's bots work on.",
		input: Schema.Struct({
			projectId: uuidSchema,
			connectorId: uuidSchema,
			...connectorRepositoryChangeSchema.fields,
		}),
		output: connectorRepositoriesSchema,
		errors: [...refusals, NotGitHubConnector],
		changes: true,
	}),
	"gitHubConnectors.gitHubAppMade": OperationContract.make("gitHubConnectors.gitHubAppMade", {
		description:
			"Make a project's GitHub app from the code GitHub sent the browser back with, and say where to install it.",
		input: Schema.Struct({
			code: Schema.optional(Schema.String),
			state: Schema.optional(Schema.String),
		}),
		output: gitHubSetupOutcomeSchema,
		errors: [],
		changes: true,
	}),
	"gitHubConnectors.gitHubAppInstalled": OperationContract.make(
		"gitHubConnectors.gitHubAppInstalled",
		{
			description:
				"Record the GitHub account a project's GitHub app was installed on, as GitHub sent the browser back.",
			input: Schema.Struct({
				installationId: Schema.optional(Schema.Int),
				state: Schema.optional(Schema.String),
			}),
			output: gitHubSetupOutcomeSchema,
			errors: [],
			changes: true,
		},
	),
	"gitHubWebhooks.delivery": OperationContract.make("gitHubWebhooks.delivery", {
		description:
			"Read what a delivery its GitHub app signed says happened at one of the app's repositories.",
		input: Schema.Struct({
			connectorId: uuidSchema,
			/** GitHub's name for the event, from its `X-GitHub-Event` header. */
			event: Schema.UndefinedOr(Schema.String),
			/** GitHub's id for the delivery, from its `X-GitHub-Delivery` header. */
			deliveryId: Schema.UndefinedOr(Schema.String),
			/** The body exactly as sent. */
			body: Schema.String,
		}),
		output: deliveredActivitySchema,
		errors: [ResourceHidden],
		changes: false,
	}),
} as const;

/** Held back: no tool manages a project's connectors yet. */
const managedInTheWebApp = {
	kind: "heldBack",
	reason:
		"No tool manages a project's connectors; members do it in the web app until tools become operations.",
} as const;

/** Held back: the step goes through the member's browser, on another site. */
const throughTheBrowser = <const Site extends string>(site: Site) =>
	({
		kind: "heldBack",
		reason: `It is where ${site} sends a member's browser back, so it is no bot's to call.`,
	}) as const;

export const connectorsExposure = {
	"connectors.searchTools": {
		http: { kind: "heldBack", reason: "Searches the connector tools offered to the current turn." },
		botLoop: {
			kind: "offered",
			tool: TOOL_SEARCH,
			offeredIn: "everywhere",
			approval: { kind: "never" },
		},
	},
	"connectors.callTool": {
		http: { kind: "heldBack", reason: "Connector tool calls belong to a turn." },
		botLoop: {
			kind: "offered",
			tool: "call_tool",
			offeredIn: "everywhere",
			approval: { kind: "byToolAccess" },
		},
	},
	"connectors.list": {
		http: { kind: "offered", endpoint: "connectors.list" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot is offered a connector's tools, not its settings; offering the list waits for tools to become operations.",
		},
	},
	"connectors.create": {
		http: { kind: "offered", endpoint: "connectors.create" },
		botLoop: managedInTheWebApp,
	},
	"connectors.testUnsaved": {
		http: { kind: "offered", endpoint: "connectors.testUnsaved" },
		botLoop: managedInTheWebApp,
	},
	"connectors.get": {
		http: { kind: "offered", endpoint: "connectors.get" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot is offered a connector's tools, not its settings; offering them waits for tools to become operations.",
		},
	},
	"connectors.update": {
		http: { kind: "offered", endpoint: "connectors.update" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It changes tool access, which a bot may change only in member bounds, and no tool does it yet.",
		},
	},
	"connectors.remove": {
		http: { kind: "offered", endpoint: "connectors.remove" },
		botLoop: managedInTheWebApp,
	},
	"connectors.test": {
		http: { kind: "offered", endpoint: "connectors.test" },
		botLoop: managedInTheWebApp,
	},
	"connectors.connectBuiltIn": {
		http: { kind: "offered", endpoint: "connectors.connectBuiltIn" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Its sign-in goes through the member's browser, at the server's authorization server, so no bot can finish it.",
		},
	},
	"connectors.startOAuth": {
		http: { kind: "offered", endpoint: "connectors.startOAuth" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A sign-in goes through the member's browser, at the server's authorization server, so no bot can finish it.",
		},
	},
	"connectors.oauthCallback": {
		http: { kind: "offered", endpoint: "connectors.oauthCallback" },
		botLoop: throughTheBrowser("an authorization server"),
	},
	"gitHubConnectors.start": {
		http: { kind: "offered", endpoint: "gitHubConnectors.start" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Making a GitHub app goes through the member's browser, on GitHub's pages, so no bot can finish it.",
		},
	},
	"gitHubConnectors.installUrl": {
		http: { kind: "offered", endpoint: "gitHubConnectors.installUrl" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Installing a GitHub app goes through the member's browser, on GitHub's pages, so no bot can finish it.",
		},
	},
	"gitHubConnectors.reachableRepositories": {
		http: { kind: "offered", endpoint: "gitHubConnectors.reachableRepositories" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It is what members choose the project's repositories from; a bot works on those chosen, through the GitHub app's tools.",
		},
	},
	"gitHubConnectors.repositories": {
		http: { kind: "offered", endpoint: "gitHubConnectors.repositories" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot is offered the GitHub app's tools, which work on these; offering the list waits for tools to become operations.",
		},
	},
	"gitHubConnectors.addRepository": {
		http: { kind: "offered", endpoint: "gitHubConnectors.addRepository" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It changes what the project's bots and computer reach at GitHub, which members choose in the web app, and no tool does it yet.",
		},
	},
	"gitHubConnectors.removeRepository": {
		http: { kind: "offered", endpoint: "gitHubConnectors.removeRepository" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It changes what the project's bots and computer reach at GitHub, which members choose in the web app, and no tool does it yet.",
		},
	},
	"gitHubConnectors.gitHubAppMade": {
		http: { kind: "offered", endpoint: "gitHubConnectors.gitHubAppMade" },
		botLoop: throughTheBrowser("GitHub"),
	},
	"gitHubConnectors.gitHubAppInstalled": {
		http: { kind: "offered", endpoint: "gitHubConnectors.gitHubAppInstalled" },
		botLoop: throughTheBrowser("GitHub"),
	},
	"gitHubWebhooks.delivery": {
		http: {
			kind: "heldBack",
			reason:
				"Webhooks call it from their own code, for a delivery its GitHub app signed; the HTTP API offers it to no session.",
		},
		botLoop: {
			kind: "heldBack",
			reason: "Only a GitHub app's own signed deliveries call it.",
		},
	},
} as const satisfies DomainExposure<typeof connectorsContracts>;
