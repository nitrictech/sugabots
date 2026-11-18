export * as GitHubConnections from "./github-connections.ts";

import type { AccountRepository, ConnectionRepositories } from "@sugabots/contracts";
import { type DomainError, userText } from "@sugabots/errors";
import { and, eq, inArray } from "drizzle-orm";
import { Context, DateTime, Effect, ErrorReporter, Layer, Schema } from "effect";
import type { AuthorizationDenied } from "../../../authorization/access.ts";
import { Authorization } from "../../../authorization/authorization.ts";
import { CurrentActor } from "../../../authorization/current-actor.ts";
import { Credentials } from "../../../credentials/credentials.ts";
import { query, serviceOperations } from "../../../database/database.ts";
import {
	type ConnectionRow,
	connection,
	type GitHubConnectionRepository,
	type GitHubConnectionSettings,
	user,
} from "../../../database/schema.ts";
import { Egress } from "../../network/egress.ts";
import { ConnectionRepository } from "../connection-repository.ts";
import { Connected } from "./connected.ts";
import { openAppCredential } from "./credential.ts";
import * as GitHub from "./github.ts";
import { activityOf, type RepositoryActivity } from "./github-events.ts";

/**
 * A bot's GitHub app (see `github-app.ts`), installed on the account the bot
 * works on: the repositories it works on there, read in its computer and
 * changed through the connection's tools, which are Sugabots' own, and what
 * happens there, which its app delivers. A bot has at most one, since its
 * computer can be signed in to only one account at GitHub. Seeing a
 * connection's repositories takes `agent.read`; choosing them takes
 * `connection.manage`.
 */
export interface Interface {
	/** What the connection's app reaches, for the bot to choose from. */
	readonly reachableRepositories: (input: {
		agentId: string;
		connectionId: string;
	}) => Effect.Effect<
		readonly AccountRepository[],
		AuthorizationDenied | NotGitHubConnection | AppNotInstalled | GitHub.GitHubRequestFailed,
		CurrentActor.Service
	>;
	readonly repositories: (input: {
		agentId: string;
		connectionId: string;
	}) => Effect.Effect<
		ConnectionRepositories,
		AuthorizationDenied | NotGitHubConnection,
		CurrentActor.Service
	>;
	/** Adds a repository the connection's app reaches. */
	readonly addRepository: (input: {
		agentId: string;
		connectionId: string;
		repository: string;
	}) => Effect.Effect<
		ConnectionRepositories,
		| AuthorizationDenied
		| NotGitHubConnection
		| AppNotInstalled
		| RepositoryUnreachable
		| GitHub.GitHubRequestFailed,
		CurrentActor.Service
	>;
	/** Removing one the connection doesn't have changes nothing. */
	readonly removeRepository: (input: {
		agentId: string;
		connectionId: string;
		repository: string;
	}) => Effect.Effect<
		ConnectionRepositories,
		AuthorizationDenied | NotGitHubConnection,
		CurrentActor.Service
	>;
	/** The bot's GitHub app, for its turns and computer; undefined until its app is installed. */
	readonly forAgent: (agent: Agent) => Effect.Effect<Connected | undefined>;
	/**
	 * What a delivery to the connection's webhook says happened at one of its
	 * account's repositories, once its app proves it sent it; `activity` is
	 * `undefined` for an event no routine is run by.
	 */
	readonly receiveDelivery: (
		delivery: Delivery & { connectionId: string },
	) => Effect.Effect<Delivered, DeliveryRefused>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/GitHubConnections",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("GitHubConnections");
	const authorization = yield* Authorization.Service;
	const credentials = yield* Credentials.Service;
	const connections = yield* ConnectionRepository.Service;
	const egress = yield* Egress.Service;
	const http = egress.providers.for({ baseUrl: GitHub.API_URL });

	const managed = (agentId: string) =>
		Effect.map(authorization.agent(agentId, "connection.manage"), agentOf);

	/** The bot's GitHub connection `connectionId`, with its app's settings. */
	const connectionOf = (agent: Agent, connectionId: string) =>
		Effect.gen(function* () {
			const [row] = yield* query((db) =>
				db
					.select()
					.from(connection)
					.where(
						and(
							eq(connection.id, connectionId),
							eq(connection.workspaceId, agent.workspaceId),
							eq(connection.agentId, agent.agentId),
							eq(connection.kind, "github"),
						),
					)
					.limit(1),
			);
			if (!row?.settings) return yield* new NotGitHubConnection();
			return { row, settings: row.settings };
		});

	/** The connection's app at the account it is installed on. */
	const installedAppOf = (agent: Agent, connectionId: string) =>
		Effect.gen(function* () {
			const { row } = yield* connectionOf(agent, connectionId);
			const app = installedApp(credentials, row);
			if (!app) return yield* new AppNotInstalled();
			return app;
		});

	/** The connection's repositories as people are shown them, with who added each. */
	const shown = (settings: GitHubConnectionSettings) =>
		Effect.gen(function* () {
			const adders = [...new Set(settings.repositories.flatMap((one) => one.addedById ?? []))];
			const names = new Map(
				adders.length === 0
					? []
					: (yield* query((db) =>
							db
								.select({ id: user.id, name: user.name })
								.from(user)
								.where(inArray(user.id, adders)),
						)).map((one) => [one.id, one.name]),
			);
			return {
				account: settings.account,
				repositories: [...settings.repositories]
					.sort((a, b) => a.path.localeCompare(b.path))
					.map((one) => ({
						repository: one.path,
						addedByName: (one.addedById && names.get(one.addedById)) ?? null,
						addedAt: one.addedAt,
					})),
			} satisfies ConnectionRepositories;
		});

	/** Changes the connection's repositories, answering them as people are shown them after. */
	const changed = (
		agent: Agent,
		connectionId: string,
		settings: GitHubConnectionSettings,
		change: (
			repositories: readonly GitHubConnectionRepository[],
		) => readonly GitHubConnectionRepository[],
	) =>
		Effect.gen(function* () {
			const repositories = yield* connections.changeGitHubRepositories(
				agent.workspaceId,
				connectionId,
				change,
			);
			if (!repositories) return yield* new NotGitHubConnection();
			return yield* shown({ ...settings, repositories });
		});

	return Service.of({
		reachableRepositories: ({ agentId, connectionId }) =>
			operation(
				"reachableRepositories",
				Effect.gen(function* () {
					const agent = yield* managed(agentId);
					const app = yield* installedAppOf(agent, connectionId);
					const reached = yield* GitHub.repositories(http, app);
					return reached.map((one) => ({ repository: one.fullName, private: one.private }));
				}),
			),

		repositories: ({ agentId, connectionId }) =>
			operation(
				"repositories",
				Effect.gen(function* () {
					const agent = agentOf(yield* authorization.agent(agentId, "connection.read"));
					const { settings } = yield* connectionOf(agent, connectionId);
					return yield* shown(settings);
				}),
			),

		addRepository: ({ agentId, connectionId, repository }) =>
			operation(
				"addRepository",
				Effect.gen(function* () {
					const agent = yield* managed(agentId);
					const { settings } = yield* connectionOf(agent, connectionId);
					const app = yield* installedAppOf(agent, connectionId);
					const reached = yield* GitHub.repositories(http, app);
					// GitHub's paths ignore case.
					const found = reached.find(
						(one) => one.fullName.toLowerCase() === repository.toLowerCase(),
					);
					if (!found) return yield* new RepositoryUnreachable({ repository });
					const { userId } = yield* CurrentActor.Service;
					const addedAt = DateTime.formatIso(yield* DateTime.now);
					const pathOf = new Map(reached.map((one) => [one.id, one.fullName]));
					return yield* changed(agent, connectionId, settings, (repositories) => [
						// GitHub has just said what each is called now, so those renamed since are kept up.
						...repositories.map((one) => ({ ...one, path: pathOf.get(one.id) ?? one.path })),
						...(repositories.some((one) => one.id === found.id)
							? []
							: [{ id: found.id, path: found.fullName, addedById: userId, addedAt }]),
					]);
				}),
			),

		removeRepository: ({ agentId, connectionId, repository }) =>
			operation(
				"removeRepository",
				Effect.gen(function* () {
					const agent = yield* managed(agentId);
					const { settings } = yield* connectionOf(agent, connectionId);
					return yield* changed(agent, connectionId, settings, (repositories) =>
						repositories.filter((one) => one.path.toLowerCase() !== repository.toLowerCase()),
					);
				}),
			),

		forAgent: (agent) =>
			operation(
				"forAgent",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.select()
							.from(connection)
							.where(
								and(
									eq(connection.workspaceId, agent.workspaceId),
									eq(connection.agentId, agent.agentId),
									eq(connection.kind, "github"),
								),
							)
							.limit(1),
					);
					const app = row && installedApp(credentials, row);
					if (!row?.settings || !app) return undefined;
					return new Connected(row, app, row.settings, { api: http, storage: egress.webFetch });
				}),
			),

		receiveDelivery: ({ connectionId, headers, body }) =>
			operation(
				"receiveDelivery",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.select()
							.from(connection)
							.where(and(eq(connection.id, connectionId), eq(connection.kind, "github")))
							.limit(1),
					);
					const secret =
						row?.appCredentialEncrypted &&
						openAppCredential(credentials, row.appCredentialEncrypted).webhookSecret;
					if (
						!row?.settings ||
						!secret ||
						!GitHub.signedDelivery(secret, body, headers["x-hub-signature-256"])
					) {
						return yield* new DeliveryRefused({ connectionId });
					}
					return {
						workspaceId: row.workspaceId,
						connectionId,
						deliveryId: headers["x-github-delivery"],
						activity: activityOf(
							headers["x-github-event"],
							GitHub.parsedJson(body),
							row.settings.slug,
						),
					};
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, ConnectionRepository.layer]),
);

export interface Agent {
	readonly workspaceId: string;
	readonly agentId: string;
}

const agentOf = (standing: { agent: { id: string; workspaceId: string } }): Agent => ({
	workspaceId: standing.agent.workspaceId,
	agentId: standing.agent.id,
});

/** The connection's app at the account it is installed on; undefined until it is installed. */
function installedApp(
	credentials: Credentials.Interface,
	row: ConnectionRow,
): GitHub.InstalledApp | undefined {
	const { settings, appCredentialEncrypted } = row;
	if (settings?.installationId == null || !settings.account || !appCredentialEncrypted) {
		return undefined;
	}
	return {
		appId: settings.appId,
		installation: { id: settings.installationId, account: settings.account },
		privateKey: openAppCredential(credentials, appCredentialEncrypted).privateKey,
	};
}

/** A GitHub connection whose app isn't installed on an account yet. */
export class AppNotInstalled
	extends Schema.TaggedError<AppNotInstalled>()("GitHubAppNotInstalled", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The connection's GitHub App isn't installed yet";
	}
	get userMessage() {
		return userText`Install the connection's GitHub App on an account first.`;
	}
}

export class NotGitHubConnection
	extends Schema.TaggedError<NotGitHubConnection>()("NotGitHubConnection", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "No such GitHub connection on the bot";
	}
	get userMessage() {
		return userText`This bot has no such GitHub app. It may have been removed.`;
	}
}

/** A second GitHub app for a bot, whose computer can be signed in to only one account there. */
export class AgentHasGitHubConnection
	extends Schema.TaggedError<AgentHasGitHubConnection>()("AgentHasGitHubConnection", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The bot already has a GitHub app";
	}
	get userMessage() {
		return userText`This bot already has a GitHub app. Add repositories to it, or remove it first to connect another account.`;
	}
}

export class RepositoryUnreachable
	extends Schema.TaggedError<RepositoryUnreachable>()("RepositoryUnreachable", {
		repository: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The account doesn't reach ${this.repository}`;
	}
	get userMessage() {
		return userText`The connection's GitHub App can't reach that repository. Give it access on GitHub first.`;
	}
}

/** A request GitHub sent the connection's webhook, as it arrived. */
export interface Delivery {
	/** Its headers, by lowercase name. */
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly body: string;
}

/** A delivery the connection's app signed, the id GitHub gave it, and what it says happened. */
export interface Delivered {
	readonly workspaceId: string;
	readonly connectionId: string;
	readonly deliveryId: string | undefined;
	readonly activity: RepositoryActivity | undefined;
}

/** A delivery for no GitHub connection, or one its app didn't send. */
export class DeliveryRefused
	extends Schema.TaggedError<DeliveryRefused>()("DeliveryRefused", {
		connectionId: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `A delivery for connection ${this.connectionId} wasn't signed by its app`;
	}
	get userMessage() {
		return userText`That delivery isn't signed by the app it's addressed to.`;
	}
}
