export {
	GitHubAppNotInstalled,
	NotGitHubConnector,
	ProjectHasGitHubConnector,
	RepositoryUnreachable,
} from "@sugabots/contracts/errors/connectors";
export * as GitHubConnectors from "./github-connectors.ts";

import type {
	AccountRepository,
	ConnectorRepositories,
	DeliveredActivity,
} from "@sugabots/contracts";
import {
	GitHubAppNotInstalled,
	type GitHubRequestFailed,
	NotGitHubConnector,
	RepositoryUnreachable,
} from "@sugabots/contracts/errors/connectors";
import { and, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { ComputerSignIn } from "../../../computers/computer-sign-in.ts";
import { query, serviceOperations } from "../../../database/database.ts";
import {
	type ConnectorRow,
	connector,
	type GitHubConnectorRepository,
	type GitHubConnectorSettings,
	project,
	projectBotConnector,
} from "../../../database/schema.ts";
import type { ReachesEnabledConnector } from "../../../proofs/can-use-connector.ts";
import type { CanManageProject, CanReadConnectors } from "../../../proofs/project-permissions.ts";
import type { Named } from "../../../proofs/proof.ts";
import type { ReachesConnector } from "../../../proofs/reaches-connector.ts";
import type { SignedByGitHubApp } from "../../../proofs/signed-by-github-app.ts";
import { Secrets } from "../../../secrets/secrets.ts";
import { processLayer, Tier } from "../../../tiers.ts";
import { memberNamesOf } from "../../../workspaces/membership/member-reads.ts";
import { Egress } from "../../network/egress.ts";
import { ConnectorStore } from "../connector-store.ts";
import { Connected } from "./connected.ts";
import { openAppCredential } from "./credential.ts";
import * as GitHub from "./github.ts";
import { activityOf } from "./github-events.ts";

/**
 * A project's GitHub app (see `github-app.ts`), installed on the account the
 * project works on: the repositories its bots work on there, read in its
 * computer and changed through the connector's tools, which are Sugabots'
 * own, and what happens there, which its app delivers. A computer signs in to one
 * app. It uses the project's own app or the shared app kept for it by the
 * upgrade. A bot's app is its default project's. Each method an operation calls
 * takes the workspace and project from its proof, and the connector it names
 * only from that project.
 */
export interface Interface {
	/** What the connector's app reaches, to choose the project's repositories from. */
	readonly reachableRepositories: <P, J, K>(
		canManage: CanManageProject<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
	) => Effect.Effect<
		readonly AccountRepository[],
		NotGitHubConnector | GitHubAppNotInstalled | GitHubRequestFailed
	>;
	readonly repositories: <P, J, K>(
		canRead: CanReadConnectors<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
	) => Effect.Effect<ConnectorRepositories, NotGitHubConnector>;
	/** Adds a repository the connector's app reaches, as added by the member who manages the project. */
	readonly addRepository: <P, J, K>(
		canManage: CanManageProject<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
		repository: string,
	) => Effect.Effect<
		ConnectorRepositories,
		NotGitHubConnector | GitHubAppNotInstalled | RepositoryUnreachable | GitHubRequestFailed
	>;
	/** Removing one the connector doesn't have changes nothing. */
	readonly removeRepository: <P, J, K>(
		canManage: CanManageProject<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
		repository: string,
	) => Effect.Effect<ConnectorRepositories, NotGitHubConnector>;
	/** The GitHub app owned by the project. */
	readonly forProject: (project: Project) => Effect.Effect<Connected | undefined>;
	/** Read-only Git sign-in for the project's computer. */
	readonly signInComputer: (project: Project) => Effect.Effect<ComputerSignIn.Source | undefined>;
	readonly forConnector: <P, K>(
		reach: ReachesEnabledConnector<P, K>,
	) => Effect.Effect<Connected | undefined>;
	/**
	 * What a delivery the connector's app signed says happened at one of its
	 * account's repositories; `activity` is `undefined` for an event no
	 * automation is run by.
	 */
	readonly readDelivery: <P, K>(
		signed: SignedByGitHubApp<P, K>,
		delivery: Delivery,
	) => Effect.Effect<DeliveredActivity>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/GitHubConnectors",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("GitHubConnectors");
	const secrets = yield* Secrets.Service;
	const connectors = yield* ConnectorStore.Service;
	const egress = yield* Egress.Service;
	// Asked for when used, so building this asks nothing of egress.
	const gitHubApi = () => egress.providers.for({ baseUrl: GitHub.API_URL });

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

	/** installedAppOf reads the app for repository setup, including while bot calls are disabled. */
	const installedAppOf = (project: Project, connectorId: string) =>
		Effect.gen(function* () {
			const { row } = yield* connectorOf(project, connectorId);
			const app = installedApp(secrets, row);
			if (!app) return yield* new GitHubAppNotInstalled();
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

	const connectedTo = (row: ConnectorRow | undefined) => {
		if (!row?.enabled || !row.settings) return undefined;
		const app = installedApp(secrets, row);
		return app
			? new Connected(row, app, row.settings, { api: gitHubApi(), storage: egress.webFetch })
			: undefined;
	};

	return Service.of({
		reachableRepositories: (_canManage, connector, target) =>
			operation(
				"reachableRepositories",
				Effect.gen(function* () {
					const app = yield* installedAppOf(projectIn(target), connector.value);
					const reached = yield* GitHub.repositories(gitHubApi(), app);
					return reached.map((one) => ({ repository: one.fullName, private: one.private }));
				}),
			),

		repositories: (_canRead, connector, target) =>
			operation(
				"repositories",
				Effect.gen(function* () {
					const { settings } = yield* connectorOf(projectIn(target), connector.value);
					return yield* shown(settings);
				}),
			),

		addRepository: (canManage, connector, target, repository) =>
			operation(
				"addRepository",
				Effect.gen(function* () {
					const project = projectIn(target);
					const connectorId = connector.value;
					const { settings } = yield* connectorOf(project, connectorId);
					const app = yield* installedAppOf(project, connectorId);
					const reached = yield* GitHub.repositories(gitHubApi(), app);
					// GitHub's paths ignore case.
					const found = reached.find(
						(one) => one.fullName.toLowerCase() === repository.toLowerCase(),
					);
					if (!found) return yield* new RepositoryUnreachable({ repository });
					const addedById = canManage.member.actor.memberId;
					const addedAt = DateTime.formatIso(yield* DateTime.now);
					const pathOf = new Map(reached.map((one) => [one.id, one.fullName]));
					return yield* changed(project, connectorId, settings, (repositories) => [
						// GitHub has just said what each is called now, so those renamed since are kept up.
						...repositories.map((one) => ({ ...one, path: pathOf.get(one.id) ?? one.path })),
						...(repositories.some((one) => one.id === found.id)
							? []
							: [{ id: found.id, path: found.fullName, addedById, addedAt }]),
					]);
				}),
			),

		removeRepository: (_canManage, connector, target, repository) =>
			operation(
				"removeRepository",
				Effect.gen(function* () {
					const project = projectIn(target);
					const connectorId = connector.value;
					const { settings } = yield* connectorOf(project, connectorId);
					return yield* changed(project, connectorId, settings, (repositories) =>
						repositories.filter((one) => one.path.toLowerCase() !== repository.toLowerCase()),
					);
				}),
			),

		forProject: (project) =>
			operation("forProject", Effect.map(gitHubConnectorForProject(project), connectedTo)),

		signInComputer: (project) =>
			operation(
				"signInComputer",
				Effect.gen(function* () {
					const connected = connectedTo(yield* findGitHubConnectorForComputer(project));
					if (!connected || connected.repositories.length === 0) {
						return undefined;
					}
					return {
						revision: `${connected.connector.id}/${connected.connector.configurationRevision}`,
						load: connected
							.computerSignIn()
							.pipe(
								Effect.catch((failure) =>
									Effect.as(
										Effect.logWarning(
											"Couldn't get a read token for a project's GitHub app",
											failure,
										),
										ComputerSignIn.NOT_SIGNED_IN,
									),
								),
							),
					};
				}),
			),

		forConnector: (reach) =>
			operation(
				"forConnector",
				Effect.map(
					gitHubConnectorForProject({ workspaceId: reach.workspace, projectId: reach.project }),
					(row) =>
						row?.id === reach.connector.value && row.configurationRevision === reach.revision
							? connectedTo(row)
							: undefined,
				),
			),

		readDelivery: (signed, { event, deliveryId, body }) =>
			operation(
				"readDelivery",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.select({ settings: connector.settings })
							.from(connector)
							.where(
								and(
									eq(connector.id, signed.connector.value),
									eq(connector.workspaceId, signed.workspace),
									eq(connector.projectId, signed.project),
									eq(connector.kind, "github"),
									eq(connector.enabled, true),
								),
							)
							.limit(1),
					);
					// Removed since its app signed the delivery, so no automation runs on it.
					const activity = row?.settings
						? activityOf(event, GitHub.parsedJson(body), row.settings.slug)
						: undefined;
					return { workspaceId: signed.workspace, deliveryId, activity };
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(ConnectorStore.layer));

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

/** The app that can sign in this computer. An app the project owns takes precedence. */
export const findGitHubConnectorForComputer = (target: Project) =>
	Effect.gen(function* () {
		const own = yield* gitHubConnectorForProject(target);
		if (own) return own;
		const [shared] = yield* query((db) =>
			db
				.select({ connector })
				.from(projectBotConnector)
				.innerJoin(
					connector,
					and(
						eq(connector.id, projectBotConnector.connectorId),
						eq(connector.workspaceId, projectBotConnector.workspaceId),
						eq(connector.addressRevision, projectBotConnector.addressRevision),
					),
				)
				.innerJoin(
					project,
					and(
						eq(project.id, connector.projectId),
						eq(project.defaultOfBotId, projectBotConnector.botId),
						eq(project.deleting, false),
					),
				)
				.where(
					and(
						eq(projectBotConnector.workspaceId, target.workspaceId),
						eq(projectBotConnector.projectId, target.projectId),
						projectBotConnector.computerSignIn,
						eq(connector.kind, "github"),
					),
				)
				.limit(1),
		);
		return shared?.connector;
	});

/** The project `reach` proved reached, by its workspace and its own id. */
const projectIn = <J>(reach: { workspace: string; project: Named<J, string> }): Project => ({
	workspaceId: reach.workspace,
	projectId: reach.project.value,
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

/** A delivery GitHub sent the connector's webhook: the event and delivery its headers name, and its body as sent. */
interface Delivery {
	readonly event: string | undefined;
	readonly deliveryId: string | undefined;
	readonly body: string;
}
