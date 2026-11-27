/**
 * The connectors operations' contracts, each with its decisions in the exposure manifest.
 * `index.ts` spreads them, so adding an operation here touches no other file.
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
	projectBotConnectorSchema,
	unsavedConnectorSchema,
} from "../connectors.ts";
import {
	ConnectorAddressChanged,
	ConnectorDoesNotUseOAuth,
	ConnectorNameTaken,
	ConnectorNeededNoSignIn,
	ConnectorNotFound,
	ConnectorOAuthStartFailed,
	GitHubAppNotInstalled,
	GitHubDeliveryIdInvalid,
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
		http: { kind: "heldBack", reason: "Searches the connector tools offered to the current turn." },
		botLoop: {
			kind: "offered",
			tool: TOOL_SEARCH,
			offeredIn: "everywhere",
			approval: { kind: "never" },
			personalBotAsks: false,
		},
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
		http: { kind: "heldBack", reason: "Connector tool calls belong to a turn." },
		botLoop: {
			kind: "offered",
			tool: "call_tool",
			offeredIn: "everywhere",
			approval: { kind: "byToolAccess" },
			// Each connector tool's own hints say whether it writes or deletes, which decides instead.
			personalBotAsks: true,
		},
	}),
	"connectors.list": OperationContract.make("connectors.list", {
		description:
			"List a project's connectors, with how many of each one's tools are at each access.",
		input: aProject,
		output: Schema.Array(connectorListItemSchema),
		errors: refusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/projects/:projectId/connectors" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot is offered a connector's tools, not its settings; offering the list waits for tools to become operations.",
		},
	}),
	"connectors.listProjectBots": OperationContract.make("connectors.listProjectBots", {
		description:
			"List the own connectors of the bots in a project, each with whether it is on in the project.",
		input: aProject,
		output: Schema.Array(projectBotConnectorSchema),
		errors: refusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/projects/:projectId/bot-connectors" },
		botLoop: managedInTheWebApp,
	}),
	"connectors.setOnInProject": OperationContract.make("connectors.setOnInProject", {
		description:
			"Turn one of a project bot's own connectors on or off in the project. Turning it on is refused once its address has changed since the manager saw it. A bot uses it in the project's chats only while it is on.",
		input: Schema.Struct({
			projectId: uuidSchema,
			connectorId: uuidSchema,
			on: Schema.Boolean,
			/** The connector's address revision as the manager saw it; turning it off goes ahead regardless. */
			addressRevision: Schema.Int,
		}),
		output: projectBotConnectorSchema,
		errors: [...refusals, ConnectorNotFound, ConnectorAddressChanged],
		changes: true,
		http: {
			kind: "offered",
			method: "PUT",
			path: "/projects/:projectId/bot-connectors/:connectorId",
		},
		botLoop: managedInTheWebApp,
	}),
	"connectors.create": OperationContract.make("connectors.create", {
		description:
			"Connect a project to an MCP server or an HTTP endpoint. A server that signs in with a key, or none, is asked for its tools straight away.",
		input: Schema.Struct({ projectId: uuidSchema, connector: newConnectorSchema }),
		output: connectorSchema,
		errors: [...refusals, UrlNotAllowed, ConnectorNameTaken, ConnectorNotFound],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/projects/:projectId/connectors", status: 201 },
		botLoop: managedInTheWebApp,
	}),
	"connectors.testUnsaved": OperationContract.make("connectors.testUnsaved", {
		description:
			"Ask the MCP server at an address, with its key, for its tools, before a connector is made with them. Nothing is saved.",
		input: Schema.Struct({ projectId: uuidSchema, ...unsavedConnectorSchema.fields }),
		output: connectorTestResultSchema,
		errors: [...refusals, UrlNotAllowed],
		changes: false,
		http: { kind: "offered", method: "POST", path: "/projects/:projectId/connectors/test" },
		botLoop: managedInTheWebApp,
	}),
	"connectors.get": OperationContract.make("connectors.get", {
		description: "Show one of a project's connectors, with each of its tools' access.",
		input: aConnector,
		output: connectorWithToolsSchema,
		errors: [...refusals, ConnectorNotFound],
		changes: false,
		http: { kind: "offered", method: "GET", path: "/projects/:projectId/connectors/:connectorId" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot is offered a connector's tools, not its settings; offering them waits for tools to become operations.",
		},
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
		http: {
			kind: "offered",
			method: "PATCH",
			path: "/projects/:projectId/connectors/:connectorId",
		},
		botLoop: {
			kind: "heldBack",
			reason:
				"It changes tool access, which a bot may change only in member bounds, and no tool does it yet.",
		},
	}),
	"connectors.remove": OperationContract.make("connectors.remove", {
		description: "Remove a connector from a project, with its key or sign-in.",
		input: aConnector,
		output: Schema.Void,
		errors: [...refusals, ConnectorNotFound],
		changes: true,
		http: {
			kind: "offered",
			method: "DELETE",
			path: "/projects/:projectId/connectors/:connectorId",
		},
		botLoop: managedInTheWebApp,
	}),
	"connectors.test": OperationContract.make("connectors.test", {
		description:
			"Ask a connector's MCP server for its tools, or check an HTTP endpoint's address without sending it anything, and record how it went.",
		input: aConnector,
		output: connectorTestResultSchema,
		errors: [...refusals, ConnectorNotFound],
		changes: true,
		http: {
			kind: "offered",
			method: "POST",
			path: "/projects/:projectId/connectors/:connectorId/test",
		},
		botLoop: managedInTheWebApp,
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
		http: {
			kind: "offered",
			method: "POST",
			path: "/projects/:projectId/connectors/connect",
			status: 201,
		},
		botLoop: {
			kind: "heldBack",
			reason:
				"Its sign-in goes through the member's browser, at the server's authorization server, so no bot can finish it.",
		},
	}),
	"connectors.startOAuth": OperationContract.make("connectors.startOAuth", {
		description:
			"Start signing a connector in with its server's OAuth: where to send the browser, or nothing when it is signed in already.",
		input: aConnector,
		output: connectorOauthStartSchema,
		errors: [...refusals, ConnectorNotFound, ConnectorDoesNotUseOAuth, ConnectorOAuthStartFailed],
		changes: true,
		http: {
			kind: "offered",
			method: "POST",
			path: "/projects/:projectId/connectors/:connectorId/oauth/start",
		},
		botLoop: {
			kind: "heldBack",
			reason:
				"A sign-in goes through the member's browser, at the server's authorization server, so no bot can finish it.",
		},
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
		http: {
			kind: "ownEndpoint",
			reason:
				"The authorization server sends the browser back to it, so it answers with a redirect to the web app.",
		},
		botLoop: throughTheBrowser("an authorization server"),
	}),
	"gitHubConnectors.start": OperationContract.make("gitHubConnectors.start", {
		description:
			"Start making a project's GitHub app, owned by a GitHub organization or by you: the form that asks GitHub to make it.",
		input: Schema.Struct({ projectId: uuidSchema, ...newGitHubAppSchema.fields }),
		output: gitHubAppFormSchema,
		errors: [...refusals, ProjectHasGitHubConnector],
		changes: false,
		http: { kind: "offered", method: "POST", path: "/projects/:projectId/github" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Making a GitHub app goes through the member's browser, on GitHub's pages, so no bot can finish it.",
		},
	}),
	"gitHubConnectors.installUrl": OperationContract.make("gitHubConnectors.installUrl", {
		description:
			"Where to install a project's GitHub app, or change which repositories it reaches.",
		input: aConnector,
		output: gitHubAppInstallSchema,
		errors: [...refusals, NotGitHubConnector],
		changes: false,
		http: {
			kind: "offered",
			method: "POST",
			path: "/projects/:projectId/connectors/:connectorId/github/install",
		},
		botLoop: {
			kind: "heldBack",
			reason:
				"Installing a GitHub app goes through the member's browser, on GitHub's pages, so no bot can finish it.",
		},
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
			http: {
				kind: "offered",
				method: "GET",
				path: "/projects/:projectId/connectors/:connectorId/github/reachable",
			},
			botLoop: {
				kind: "heldBack",
				reason:
					"It is what members choose the project's repositories from; a bot works on those chosen, through the GitHub app's tools.",
			},
		},
	),
	"gitHubConnectors.repositories": OperationContract.make("gitHubConnectors.repositories", {
		description:
			"List the repositories a project's bots work on through its GitHub app, and who added each.",
		input: aConnector,
		output: connectorRepositoriesSchema,
		errors: [...refusals, NotGitHubConnector],
		changes: false,
		http: {
			kind: "offered",
			method: "GET",
			path: "/projects/:projectId/connectors/:connectorId/repositories",
		},
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot is offered the GitHub app's tools, which work on these; offering the list waits for tools to become operations.",
		},
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
		http: {
			kind: "offered",
			method: "POST",
			path: "/projects/:projectId/connectors/:connectorId/repositories",
		},
		botLoop: {
			kind: "heldBack",
			reason:
				"It changes what the project's bots and computer reach at GitHub, which members choose in the web app, and no tool does it yet.",
		},
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
		http: {
			kind: "offered",
			method: "POST",
			path: "/projects/:projectId/connectors/:connectorId/repositories/remove",
		},
		botLoop: {
			kind: "heldBack",
			reason:
				"It changes what the project's bots and computer reach at GitHub, which members choose in the web app, and no tool does it yet.",
		},
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
		http: {
			kind: "ownEndpoint",
			reason: "GitHub sends the browser back to it, so it answers with a redirect.",
		},
		botLoop: throughTheBrowser("GitHub"),
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
			http: {
				kind: "ownEndpoint",
				reason: "GitHub sends the browser back to it, so it answers with a redirect.",
			},
			botLoop: throughTheBrowser("GitHub"),
		},
	),
	"gitHubWebhooks.delivery": OperationContract.make("gitHubWebhooks.delivery", {
		description: "Accept a signed GitHub delivery and start the connector's matching automations.",
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
		errors: [ResourceHidden, GitHubDeliveryIdInvalid],
		changes: true,
		http: {
			kind: "heldBack",
			reason:
				"Webhooks call it from their own code, for a delivery its GitHub app signed; the HTTP API offers it to no session.",
		},
		botLoop: {
			kind: "heldBack",
			reason: "Only a GitHub app's own signed deliveries call it.",
		},
	}),
} as const;
