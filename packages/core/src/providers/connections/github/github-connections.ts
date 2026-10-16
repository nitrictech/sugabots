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
import { openAppCredential } from "./credential.ts";
import * as GitHub from "./github.ts";

/**
 * A pod's GitHub connection, to the pod's own GitHub App (see
 * `github-app.ts`), installed on the account the pod works on: the
 * repositories its bots work on there, read in the pod's sandbox and changed
 * through the connection's tools, which are Sugabots' own. A pod has at most
 * one, since its sandbox can be signed in to only one account at GitHub.
 * Seeing a connection's repositories takes `pod.read`; choosing them takes
 * `connection.manage`.
 */
export interface Interface {
	/** What the connection's app reaches, for the pod to choose from. */
	readonly reachableRepositories: (input: {
		podId: string;
		connectionId: string;
	}) => Effect.Effect<
		readonly AccountRepository[],
		AuthorizationDenied | NotGitHubConnection | AppNotInstalled | GitHub.GitHubRequestFailed,
		CurrentActor.Service
	>;
	readonly repositories: (input: {
		podId: string;
		connectionId: string;
	}) => Effect.Effect<
		ConnectionRepositories,
		AuthorizationDenied | NotGitHubConnection,
		CurrentActor.Service
	>;
	/** Adds a repository the connection's app reaches. */
	readonly addRepository: (input: {
		podId: string;
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
		podId: string;
		connectionId: string;
		repository: string;
	}) => Effect.Effect<
		ConnectionRepositories,
		AuthorizationDenied | NotGitHubConnection,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/GitHubConnections",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("GitHubConnections");
	const authorization = yield* Authorization.Service;
	const credentials = yield* Credentials.Service;
	const connections = yield* ConnectionRepository.Service;
	const http = (yield* Egress.Service).providers.for({ baseUrl: GitHub.API_URL });

	const managed = (podId: string) =>
		Effect.map(authorization.pod(podId, "connection.manage"), podOf);

	/** The pod's GitHub connection `connectionId`, with its app's settings. */
	const connectionOf = (pod: Pod, connectionId: string) =>
		Effect.gen(function* () {
			const [row] = yield* query((db) =>
				db
					.select()
					.from(connection)
					.where(
						and(
							eq(connection.id, connectionId),
							eq(connection.workspaceId, pod.workspaceId),
							eq(connection.podId, pod.podId),
							eq(connection.kind, "github"),
						),
					)
					.limit(1),
			);
			if (!row?.settings) return yield* new NotGitHubConnection();
			return { row, settings: row.settings };
		});

	/** The connection's app at the account it is installed on. */
	const installedAppOf = (pod: Pod, connectionId: string) =>
		Effect.gen(function* () {
			const { row } = yield* connectionOf(pod, connectionId);
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
		pod: Pod,
		connectionId: string,
		settings: GitHubConnectionSettings,
		change: (
			repositories: readonly GitHubConnectionRepository[],
		) => readonly GitHubConnectionRepository[],
	) =>
		Effect.gen(function* () {
			const repositories = yield* connections.changeGitHubRepositories(
				pod.workspaceId,
				connectionId,
				change,
			);
			if (!repositories) return yield* new NotGitHubConnection();
			return yield* shown({ ...settings, repositories });
		});

	return Service.of({
		reachableRepositories: ({ podId, connectionId }) =>
			operation(
				"reachableRepositories",
				Effect.gen(function* () {
					const pod = yield* managed(podId);
					const app = yield* installedAppOf(pod, connectionId);
					const reached = yield* GitHub.repositories(http, app);
					return reached.map((one) => ({ repository: one.fullName, private: one.private }));
				}),
			),

		repositories: ({ podId, connectionId }) =>
			operation(
				"repositories",
				Effect.gen(function* () {
					const pod = podOf(yield* authorization.pod(podId, "pod.read"));
					const { settings } = yield* connectionOf(pod, connectionId);
					return yield* shown(settings);
				}),
			),

		addRepository: ({ podId, connectionId, repository }) =>
			operation(
				"addRepository",
				Effect.gen(function* () {
					const pod = yield* managed(podId);
					const { settings } = yield* connectionOf(pod, connectionId);
					const app = yield* installedAppOf(pod, connectionId);
					const reached = yield* GitHub.repositories(http, app);
					// GitHub's paths ignore case.
					const found = reached.find(
						(one) => one.fullName.toLowerCase() === repository.toLowerCase(),
					);
					if (!found) return yield* new RepositoryUnreachable({ repository });
					const { userId } = yield* CurrentActor.Service;
					const addedAt = DateTime.formatIso(yield* DateTime.now);
					const pathOf = new Map(reached.map((one) => [one.id, one.fullName]));
					return yield* changed(pod, connectionId, settings, (repositories) => [
						// GitHub has just said what each is called now, so those renamed since are kept up.
						...repositories.map((one) => ({ ...one, path: pathOf.get(one.id) ?? one.path })),
						...(repositories.some((one) => one.id === found.id)
							? []
							: [{ id: found.id, path: found.fullName, addedById: userId, addedAt }]),
					]);
				}),
			),

		removeRepository: ({ podId, connectionId, repository }) =>
			operation(
				"removeRepository",
				Effect.gen(function* () {
					const pod = yield* managed(podId);
					const { settings } = yield* connectionOf(pod, connectionId);
					return yield* changed(pod, connectionId, settings, (repositories) =>
						repositories.filter((one) => one.path.toLowerCase() !== repository.toLowerCase()),
					);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, ConnectionRepository.layer]),
);

export interface Pod {
	readonly workspaceId: string;
	readonly podId: string;
}

const podOf = (standing: { pod: { id: string; workspaceId: string } }): Pod => ({
	workspaceId: standing.pod.workspaceId,
	podId: standing.pod.id,
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
		return "No such GitHub connection in the pod";
	}
	get userMessage() {
		return userText`This pod has no such GitHub connection. It may have been removed.`;
	}
}

/** A second GitHub connection for a pod, whose sandbox can be signed in to only one account there. */
export class PodHasGitHubConnection
	extends Schema.TaggedError<PodHasGitHubConnection>()("PodHasGitHubConnection", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The pod already has a GitHub connection";
	}
	get userMessage() {
		return userText`This pod is already connected to GitHub. Add repositories to that connection, or remove it first to connect another account.`;
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
