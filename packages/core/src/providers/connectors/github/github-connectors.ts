export * as GitHubConnectors from "./github-connectors.ts";

import type { AccountRepository, ConnectorRepositories } from "@sugabots/contracts";
import { type DomainError, userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, DateTime, Effect, ErrorReporter, Layer, Schema } from "effect";
import type { AuthorizationDenied } from "../../../authorization/access.ts";
import { Authorization } from "../../../authorization/authorization.ts";
import { CurrentActor } from "../../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../../database/database.ts";
import {
	type ConnectorRow,
	connector,
	type GitHubConnectorRepository,
	type GitHubConnectorSettings,
} from "../../../database/schema.ts";
import { Secrets } from "../../../secrets/secrets.ts";
import { memberNamesOf } from "../../../workspaces/membership/member-reads.ts";
import { Egress } from "../../network/egress.ts";
import { ConnectorStore } from "../connector-store.ts";
import { Connected } from "./connected.ts";
import { openAppCredential } from "./credential.ts";
import * as GitHub from "./github.ts";
import { activityOf, type RepositoryActivity } from "./github-events.ts";

/**
 * A project's GitHub app (see `github-app.ts`), installed on the account the
 * project works on: the repositories its bots work on there, read in its
 * computer and changed through the connector's tools, which are Sugabots'
 * own, and what happens there, which its app delivers. A project has at most
 * one, since its computer can be signed in to only one account at GitHub; a
 * bot's is its default project's. Seeing a connector's repositories takes
 * `connector.read`; choosing them takes `connector.manage`.
 */
export interface Interface {
	/** What the connector's app reaches, to choose the project's repositories from. */
	readonly reachableRepositories: (input: {
		projectId: string;
		connectorId: string;
	}) => Effect.Effect<
		readonly AccountRepository[],
		AuthorizationDenied | NotGitHubConnector | AppNotInstalled | GitHub.GitHubRequestFailed,
		CurrentActor.Service
	>;
	readonly repositories: (input: {
		projectId: string;
		connectorId: string;
	}) => Effect.Effect<
		ConnectorRepositories,
		AuthorizationDenied | NotGitHubConnector,
		CurrentActor.Service
	>;
	/** Adds a repository the connector's app reaches. */
	readonly addRepository: (input: {
		projectId: string;
		connectorId: string;
		repository: string;
	}) => Effect.Effect<
		ConnectorRepositories,
		| AuthorizationDenied
		| NotGitHubConnector
		| AppNotInstalled
		| RepositoryUnreachable
		| GitHub.GitHubRequestFailed,
		CurrentActor.Service
	>;
	/** Removing one the connector doesn't have changes nothing. */
	readonly removeRepository: (input: {
		projectId: string;
		connectorId: string;
		repository: string;
	}) => Effect.Effect<
		ConnectorRepositories,
		AuthorizationDenied | NotGitHubConnector,
		CurrentActor.Service
	>;
	/**
	 * The project's GitHub app, for the turns in it and its computer;
	 * undefined until its app is installed.
	 */
	readonly forProject: (project: Project) => Effect.Effect<Connected | undefined>;
	/**
	 * What a delivery to the connector's webhook says happened at one of its
	 * account's repositories, once its app proves it sent it; `activity` is
	 * `undefined` for an event no automation is run by.
	 */
	readonly receiveDelivery: (
		delivery: Delivery & { connectorId: string },
	) => Effect.Effect<Delivered, DeliveryRefused>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/GitHubConnectors",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("GitHubConnectors");
	const authorization = yield* Authorization.Service;
	const secrets = yield* Secrets.Service;
	const connectors = yield* ConnectorStore.Service;
	const egress = yield* Egress.Service;
	const http = egress.providers.for({ baseUrl: GitHub.API_URL });

	const managed = (projectId: string) =>
		Effect.map(authorization.project(projectId, "connector.manage"), projectOf);

	/** The project's GitHub connector `connectorId`, with its app's settings. */
	const connectorOf = (project: Project, connectorId: string) =>
		Effect.gen(function* () {
			const [row] = yield* query((db) =>
				db
					.select()
					.from(connector)
					.where(
						and(
							eq(connector.id, connectorId),
							eq(connector.workspaceId, project.workspaceId),
							eq(connector.projectId, project.projectId),
							eq(connector.kind, "github"),
						),
					)
					.limit(1),
			);
			if (!row?.settings) return yield* new NotGitHubConnector();
			return { row, settings: row.settings };
		});

	/** The connector's app at the account it is installed on. */
	const installedAppOf = (project: Project, connectorId: string) =>
		Effect.gen(function* () {
			const { row } = yield* connectorOf(project, connectorId);
			const app = installedApp(secrets, row);
			if (!app) return yield* new AppNotInstalled();
			return app;
		});

	/** The connector's repositories as members are shown them, with who added each. */
	const shown = (settings: GitHubConnectorSettings) =>
		Effect.gen(function* () {
			const names = yield* memberNamesOf(settings.repositories.map((one) => one.addedById ?? null));
			return {
				account: settings.account,
				repositories: [...settings.repositories]
					.sort((a, b) => a.path.localeCompare(b.path))
					.map((one) => ({
						repository: one.path,
						addedByName: (one.addedById && names.get(one.addedById)) ?? null,
					})),
			} satisfies ConnectorRepositories;
		});

	/** Changes the connector's repositories, answering them as members are shown them after. */
	const changed = (
		project: Project,
		connectorId: string,
		settings: GitHubConnectorSettings,
		change: (
			repositories: readonly GitHubConnectorRepository[],
		) => readonly GitHubConnectorRepository[],
	) =>
		Effect.gen(function* () {
			const repositories = yield* connectors.changeGitHubRepositories(
				project.workspaceId,
				connectorId,
				change,
			);
			if (!repositories) return yield* new NotGitHubConnector();
			return yield* shown({ ...settings, repositories });
		});

	return Service.of({
		reachableRepositories: ({ projectId, connectorId }) =>
			operation(
				"reachableRepositories",
				Effect.gen(function* () {
					const project = yield* managed(projectId);
					const app = yield* installedAppOf(project, connectorId);
					const reached = yield* GitHub.repositories(http, app);
					return reached.map((one) => ({ repository: one.fullName, private: one.private }));
				}),
			),

		repositories: ({ projectId, connectorId }) =>
			operation(
				"repositories",
				Effect.gen(function* () {
					const project = projectOf(yield* authorization.project(projectId, "connector.read"));
					const { settings } = yield* connectorOf(project, connectorId);
					return yield* shown(settings);
				}),
			),

		addRepository: ({ projectId, connectorId, repository }) =>
			operation(
				"addRepository",
				Effect.gen(function* () {
					const project = yield* managed(projectId);
					const { settings } = yield* connectorOf(project, connectorId);
					const app = yield* installedAppOf(project, connectorId);
					const reached = yield* GitHub.repositories(http, app);
					// GitHub's paths ignore case.
					const found = reached.find(
						(one) => one.fullName.toLowerCase() === repository.toLowerCase(),
					);
					if (!found) return yield* new RepositoryUnreachable({ repository });
					const { memberId } = yield* CurrentActor.Service;
					const addedAt = DateTime.formatIso(yield* DateTime.now);
					const pathOf = new Map(reached.map((one) => [one.id, one.fullName]));
					return yield* changed(project, connectorId, settings, (repositories) => [
						// GitHub has just said what each is called now, so those renamed since are kept up.
						...repositories.map((one) => ({ ...one, path: pathOf.get(one.id) ?? one.path })),
						...(repositories.some((one) => one.id === found.id)
							? []
							: [{ id: found.id, path: found.fullName, addedById: memberId, addedAt }]),
					]);
				}),
			),

		removeRepository: ({ projectId, connectorId, repository }) =>
			operation(
				"removeRepository",
				Effect.gen(function* () {
					const project = yield* managed(projectId);
					const { settings } = yield* connectorOf(project, connectorId);
					return yield* changed(project, connectorId, settings, (repositories) =>
						repositories.filter((one) => one.path.toLowerCase() !== repository.toLowerCase()),
					);
				}),
			),

		forProject: (project) =>
			operation(
				"forProject",
				Effect.gen(function* () {
					const row = yield* gitHubConnectorForProject(project);
					const app = row && installedApp(secrets, row);
					if (!row?.settings || !app) return undefined;
					return new Connected(row, app, row.settings, { api: http, storage: egress.webFetch });
				}),
			),

		receiveDelivery: ({ connectorId, headers, body }) =>
			operation(
				"receiveDelivery",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.select()
							.from(connector)
							.where(and(eq(connector.id, connectorId), eq(connector.kind, "github")))
							.limit(1),
					);
					const secret =
						row?.appCredentialEncrypted &&
						openAppCredential(secrets, row.appCredentialEncrypted).webhookSecret;
					if (
						!row?.settings ||
						!secret ||
						!GitHub.signedDelivery(secret, body, headers["x-hub-signature-256"])
					) {
						return yield* new DeliveryRefused({ connectorId });
					}
					return {
						workspaceId: row.workspaceId,
						connectorId,
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

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, ConnectorStore.layer]));

/** A project, by its workspace and its own id. */
export interface Project {
	readonly workspaceId: string;
	readonly projectId: string;
}

/** The project's GitHub app as stored, whether or not it is installed yet; each project has at most one. */
export const gitHubConnectorForProject = (project: Project) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(connector)
				.where(
					and(
						eq(connector.workspaceId, project.workspaceId),
						eq(connector.projectId, project.projectId),
						eq(connector.kind, "github"),
					),
				)
				.limit(1),
		),
		([row]) => row,
	);

const projectOf = (standing: { project: { id: string; workspaceId: string } }): Project => ({
	workspaceId: standing.project.workspaceId,
	projectId: standing.project.id,
});

/** The connector's app at the account it is installed on; undefined until it is installed. */
function installedApp(
	secrets: Secrets.Interface,
	row: ConnectorRow,
): GitHub.InstalledApp | undefined {
	const { settings, appCredentialEncrypted } = row;
	if (settings?.installationId == null || !settings.account || !appCredentialEncrypted) {
		return undefined;
	}
	return {
		appId: settings.appId,
		installation: { id: settings.installationId, account: settings.account },
		privateKey: openAppCredential(secrets, appCredentialEncrypted).privateKey,
	};
}

/** A GitHub connector whose app isn't installed on an account yet. */
class AppNotInstalled
	extends Schema.TaggedError<AppNotInstalled>()("GitHubAppNotInstalled", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The connector's GitHub App isn't installed yet";
	}
	get userMessage() {
		return userText`Install the connector's GitHub App on an account first.`;
	}
}

export class NotGitHubConnector
	extends Schema.TaggedError<NotGitHubConnector>()("NotGitHubConnector", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "No such GitHub connector in the project";
	}
	get userMessage() {
		return userText`There's no such GitHub app here. It may have been removed.`;
	}
}

/** A second GitHub app for a project, whose computer can be signed in to only one account there. */
export class ProjectHasGitHubConnector
	extends Schema.TaggedError<ProjectHasGitHubConnector>()("ProjectHasGitHubConnector", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The project already has a GitHub app";
	}
	get userMessage() {
		return userText`There's a GitHub app here already. Add repositories to it, or remove it first to connect another account.`;
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
		return userText`The connector's GitHub App can't reach that repository. Give it access on GitHub first.`;
	}
}

/** A request GitHub sent the connector's webhook, as it arrived. */
interface Delivery {
	/** Its headers, by lowercase name. */
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly body: string;
}

/** A delivery the connector's app signed, the id GitHub gave it, and what it says happened. */
interface Delivered {
	readonly workspaceId: string;
	readonly connectorId: string;
	readonly deliveryId: string | undefined;
	readonly activity: RepositoryActivity | undefined;
}

/** A delivery for no GitHub connector, or one its app didn't send. */
export class DeliveryRefused
	extends Schema.TaggedError<DeliveryRefused>()("DeliveryRefused", {
		connectorId: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `A delivery for connector ${this.connectorId} wasn't signed by its app`;
	}
	get userMessage() {
		return userText`That delivery isn't signed by the app it's addressed to.`;
	}
}
