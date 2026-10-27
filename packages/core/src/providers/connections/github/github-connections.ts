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
import type { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import { Egress, type EgressHttpClient } from "../../network/egress.ts";
import { ConnectionRepository } from "../connection-repository.ts";
import { openAppCredential } from "./credential.ts";
import * as GitHub from "./github.ts";
import { activityOf, type RepositoryActivity } from "./github-events.ts";
import * as GitHubReads from "./github-reads.ts";

/**
 * A pod's GitHub connection, to the pod's own GitHub App (see
 * `github-app.ts`), installed on the account the pod works on: the
 * repositories its bots work on there, read in the pod's sandbox and changed
 * through the connection's tools, which are Sugabots' own, and what happens
 * there, which its app delivers. A pod has at most one, since its sandbox
 * can be signed in to only one account at GitHub. Seeing a connection's
 * repositories takes `pod.read`; choosing them takes `connection.manage`.
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
	/** The pod's GitHub connection, for its turns and sandbox; undefined until its app is installed. */
	readonly forPod: (pod: Pod) => Effect.Effect<Connected | undefined>;
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

		forPod: (pod) =>
			operation(
				"forPod",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.select()
							.from(connection)
							.where(
								and(
									eq(connection.workspaceId, pod.workspaceId),
									eq(connection.podId, pod.podId),
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

/** Bots push only to branches under this, so they can't move anyone else's. */
export const BOT_BRANCH_PREFIX = "sugabots/";

/** The username git sends an installation token with. */
const TOKEN_USERNAME = "x-access-token";

/**
 * A pod's GitHub connection as its turns and sandbox use it: each token is
 * for its account's installation, and only for its repositories.
 */
export class Connected {
	readonly connection: ConnectionRow;
	/** Its repositories' paths, as GitHub last wrote them. */
	readonly repositories: readonly string[];
	/** GitHub's id for each of its repositories, by path. */
	private readonly ids: ReadonlyMap<string, number>;
	private readonly app: GitHub.InstalledApp;
	/** The login GitHub shows for what the connection's app writes. */
	private readonly botLogin: string;
	private readonly http: EgressHttpClient;
	/** Reaches where GitHub's API redirects to, such as a job's log at its storage. */
	private readonly storage: EgressHttpClient;

	constructor(
		connection: ConnectionRow,
		app: GitHub.InstalledApp,
		settings: GitHubConnectionSettings,
		clients: { api: EgressHttpClient; storage: EgressHttpClient },
	) {
		this.connection = connection;
		this.app = app;
		this.botLogin = `${settings.slug}[bot]`;
		this.repositories = settings.repositories.map((one) => one.path);
		this.ids = new Map(settings.repositories.map((one) => [one.path, one.id]));
		this.http = clients.api;
		this.storage = clients.storage;
	}

	get account() {
		return this.app.installation.account;
	}

	/**
	 * GitHub's id for `repository`, as `repository()` gives it. Asking for
	 * another is a mistake, not a token for every repository the app reaches.
	 */
	private idOf(repository: string): number {
		const id = this.ids.get(repository);
		if (id === undefined)
			throw new Error(`${repository} isn't one of the connection's repositories`);
		return id;
	}

	/** `repository` as the connection has it, if it is one of its, whatever its case. */
	repository(repository: string): string | undefined {
		return this.repositories.find((one) => one.toLowerCase() === repository.toLowerCase());
	}

	/** A read-only token for the connection's repositories. */
	readToken() {
		return Effect.map(
			GitHub.accessToken(this.http, this.app, {
				repositoryIds: [...this.ids.values()],
				permissions: GitHub.READ_PERMISSIONS,
			}),
			(token) => token.token,
		);
	}

	/**
	 * What the pod's sandbox reads the repositories with: git's sign-in to the
	 * account's paths, added outside the sandbox by its provider. Nothing for
	 * GitHub's API, whose paths don't all name the account: bots read through
	 * the connection's tools instead.
	 */
	sandboxSignIn() {
		return Effect.map(
			GitHub.accessToken(this.http, this.app, {
				repositoryIds: [...this.ids.values()],
				permissions: { contents: "read", metadata: "read" },
			}),
			(token): SandboxSignIn => ({
				credentials: [
					{
						host: new URL(GitHub.WEB_URL).host,
						pathPrefix: `/${this.account}/`,
						header: "Authorization",
						value: GitHub.redactedBasicAuthorization({
							username: TOKEN_USERNAME,
							token: token.token,
						}),
					},
				],
				expiresAt: token.expiresAt,
			}),
		);
	}

	/** A token that can push to `repository` alone. */
	writeCredential(repository: string) {
		return Effect.map(
			Effect.suspend(() =>
				GitHub.accessToken(this.http, this.app, {
					repositoryIds: [this.idOf(repository)],
					permissions: { contents: "write" },
				}),
			),
			(token): GitHub.GitCredential => ({ username: TOKEN_USERNAME, token: token.token }),
		);
	}

	/** Opens a pull request from `head`, into `base` or the repository's default branch. */
	openPullRequest(request: {
		repository: string;
		head: string;
		base: string | undefined;
		title: string;
		body: string;
		draft: boolean;
	}) {
		const { http, app } = this;
		const idOf = (repository: string) => this.idOf(repository);
		return Effect.gen(function* () {
			const { token } = yield* GitHub.accessToken(http, app, {
				repositoryIds: [idOf(request.repository)],
				permissions: { pull_requests: "write", contents: "read" },
			});
			return yield* GitHub.openPullRequest(http, token, {
				...request,
				base: request.base ?? (yield* GitHub.defaultBranch(http, token, request.repository)),
			});
		});
	}

	/**
	 * Changes a pull request bots opened, from a branch under
	 * {@link BOT_BRANCH_PREFIX} in `repository` itself, so bots can't rewrite
	 * or close anyone else's. What isn't given stays as it is.
	 */
	updatePullRequest(request: {
		repository: string;
		number: number;
		title: string | undefined;
		body: string | undefined;
		base: string | undefined;
		state: "open" | "closed" | undefined;
		draft: boolean | undefined;
	}) {
		const { http, app } = this;
		const idOf = (repository: string) => this.idOf(repository);
		return Effect.gen(function* () {
			const { token } = yield* GitHub.accessToken(http, app, {
				repositoryIds: [idOf(request.repository)],
				permissions: { pull_requests: "write", contents: "read" },
			});
			const head = yield* GitHub.pullRequestHead(http, token, request);
			const fromBotBranch =
				head.branch.startsWith(BOT_BRANCH_PREFIX) &&
				head.branchRepository?.toLowerCase() === request.repository.toLowerCase();
			if (!fromBotBranch) {
				return yield* new NotBotPullRequest({ number: request.number, branch: head.branch });
			}
			if (request.draft !== undefined && request.draft !== head.draft) {
				yield* GitHub.setPullRequestDraft(http, token, {
					nodeId: head.nodeId,
					draft: request.draft,
				});
			}
			return yield* GitHub.updatePullRequest(http, token, request);
		});
	}

	/** Comments on pull request `number`, anyone's. */
	commentOnPullRequest(request: { repository: string; number: number; body: string }) {
		return Effect.flatMap(
			Effect.suspend(() =>
				GitHub.accessToken(this.http, this.app, {
					repositoryIds: [this.idOf(request.repository)],
					permissions: { pull_requests: "write" },
				}),
			),
			({ token }) => GitHub.comment(this.http, token, request),
		);
	}

	/**
	 * A token for `repository` alone with `permissions`, or
	 * {@link PermissionNotGranted} when the installation hasn't been granted
	 * them, as for an app made before they were asked for.
	 */
	private tokenFor(repository: string, permissions: GitHub.Permissions) {
		return Effect.suspend(() =>
			GitHub.accessToken(this.http, this.app, {
				repositoryIds: [this.idOf(repository)],
				permissions,
			}),
		).pipe(
			Effect.map(({ token }) => token),
			Effect.catchIf(
				(failure) => failure.status === UNGRANTED_PERMISSIONS_STATUS,
				() =>
					Effect.fail(new PermissionNotGranted({ permissions: describedPermissions(permissions) })),
			),
		);
	}

	/** Comments on issue `number`, anyone's. */
	commentOnIssue(request: { repository: string; number: number; body: string }) {
		return Effect.flatMap(this.tokenFor(request.repository, { issues: "write" }), (token) =>
			GitHub.comment(this.http, token, request),
		);
	}

	/** Reacts to an issue, a pull request or a comment, anyone's. */
	react(request: {
		repository: string;
		subject: GitHub.ReactionSubject | { kind: "pull_request"; number: number };
		reaction: GitHub.Reaction;
	}) {
		const { subject } = request;
		const onPullRequest = subject.kind === "pull_request" || subject.kind === "code_comment";
		return Effect.flatMap(
			this.tokenFor(
				request.repository,
				onPullRequest ? { pull_requests: "write" } : { issues: "write" },
			),
			(token) =>
				GitHub.react(this.http, token, {
					...request,
					subject:
						subject.kind === "pull_request" ? { kind: "issue", number: subject.number } : subject,
				}),
		);
	}

	/**
	 * Replaces the words of a comment the connection's app wrote, so bots
	 * can't rewrite anyone else's.
	 */
	editComment(request: {
		repository: string;
		kind: GitHub.CommentKind;
		commentId: number;
		body: string;
	}) {
		return Effect.flatMap(this.ownComment(request), (token) =>
			GitHub.editComment(this.http, token, request),
		);
	}

	/** Deletes a comment the connection's app wrote, and no one else's. */
	deleteComment(request: { repository: string; kind: GitHub.CommentKind; commentId: number }) {
		return Effect.flatMap(this.ownComment(request), (token) =>
			GitHub.deleteComment(this.http, token, request),
		);
	}

	/** A token to change comment `commentId`, once it is shown to be the app's own. */
	private ownComment(request: { repository: string; kind: GitHub.CommentKind; commentId: number }) {
		const { http } = this;
		const botLogin = this.botLogin;
		const permissions: GitHub.Permissions =
			request.kind === "code_comment" ? { pull_requests: "write" } : { issues: "write" };
		return Effect.flatMap(this.tokenFor(request.repository, permissions), (token) =>
			Effect.gen(function* () {
				const author = yield* GitHub.commentAuthor(http, token, request);
				if (author !== botLogin) {
					return yield* new NotBotComment({
						commentId: request.commentId,
						author: author ?? "ghost",
					});
				}
				return token;
			}),
		);
	}

	openIssue(request: {
		repository: string;
		title: string;
		body: string;
		labels: readonly string[] | undefined;
		assignees: readonly string[] | undefined;
	}) {
		return Effect.flatMap(this.tokenFor(request.repository, { issues: "write" }), (token) =>
			GitHub.openIssue(this.http, token, request),
		);
	}

	/**
	 * Changes an issue or pull request. Bots label and assign anyone's, and
	 * close or reopen anyone's issue, but change the title or description only
	 * of what the connection's app opened, and open or close only its own pull
	 * requests, as {@link updatePullRequest} does. What isn't given stays as it is.
	 */
	updateIssue(request: {
		repository: string;
		number: number;
		title: string | undefined;
		body: string | undefined;
		state: "open" | "closed" | undefined;
		closedReason: GitHub.ClosedReason | undefined;
		labels: readonly string[] | undefined;
		assignees: readonly string[] | undefined;
	}) {
		const { http } = this;
		const botLogin = this.botLogin;
		return Effect.flatMap(
			this.tokenFor(request.repository, { issues: "write", pull_requests: "write" }),
			(token) =>
				Effect.gen(function* () {
					const changesWords = request.title !== undefined || request.body !== undefined;
					const changesState = request.state !== undefined || request.closedReason !== undefined;
					if (changesWords || changesState) {
						const found = yield* GitHub.issueAuthor(http, token, request);
						const author = found.author ?? "ghost";
						if (author !== botLogin && changesWords) {
							return yield* new NotBotIssue({
								number: request.number,
								author,
								change: "title or description",
							});
						}
						if (author !== botLogin && changesState && found.isPullRequest) {
							return yield* new NotBotIssue({ number: request.number, author, change: "state" });
						}
					}
					return yield* GitHub.updateIssue(http, token, request);
				}),
		);
	}

	/** Reviews pull request `number`, anyone's. */
	reviewPullRequest(request: {
		repository: string;
		number: number;
		verdict: GitHub.ReviewVerdict;
		body: string;
		commit: string | undefined;
		comments: readonly GitHub.LineComment[];
	}) {
		return Effect.flatMap(this.tokenFor(request.repository, { pull_requests: "write" }), (token) =>
			GitHub.reviewPullRequest(this.http, token, request),
		);
	}

	/** Replies in the thread of a comment on pull request `number`'s code. */
	replyToCodeComment(request: {
		repository: string;
		number: number;
		commentId: number;
		body: string;
	}) {
		return Effect.flatMap(this.tokenFor(request.repository, { pull_requests: "write" }), (token) =>
			GitHub.replyToCodeComment(this.http, token, request),
		);
	}

	/** The end of a GitHub Actions job's log, with a read-only token. */
	jobLog(request: { repository: string; jobId: number }) {
		return Effect.flatMap(this.readToken(), (token) =>
			GitHubReads.jobLog(this.http, this.storage, token, request),
		);
	}

	/** Runs `read` with a read-only token for the connection's repositories. */
	read<A>(
		read: (http: EgressHttpClient, token: string) => Effect.Effect<A, GitHub.GitHubRequestFailed>,
	) {
		return Effect.flatMap(this.readToken(), (token) => read(this.http, token));
	}
}

/** What a pod's sandbox is signed in to GitHub with, and when it must be replaced. */
export interface SandboxSignIn {
	readonly credentials: readonly Sandboxes.Credential[];
	readonly expiresAt: GitHub.AccessToken["expiresAt"];
}

/** A pull request that isn't from a bot's branch, which bots may comment on but not change. */
export class NotBotPullRequest
	extends Schema.TaggedError<NotBotPullRequest>()("NotBotPullRequest", {
		number: Schema.Int,
		branch: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `Pull request #${this.number} is from ${this.branch}, not a branch under ${BOT_BRANCH_PREFIX}`;
	}
	get userMessage() {
		return userText`Bots can only change pull requests from their own branches.`;
	}
}

/** A comment the connection's app didn't write, which bots may react to and reply to but not change. */
export class NotBotComment
	extends Schema.TaggedError<NotBotComment>()("NotBotComment", {
		commentId: Schema.Int,
		author: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `Comment ${this.commentId} is ${this.author}'s, not the connection's app's`;
	}
	get userMessage() {
		return userText`Bots can only change their own comments.`;
	}
}

/** A change to an issue or pull request that only what the connection's app opened may have. */
export class NotBotIssue
	extends Schema.TaggedError<NotBotIssue>()("NotBotIssue", {
		number: Schema.Int,
		author: Schema.String,
		change: Schema.Literals(["title or description", "state"]),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `#${this.number} is ${this.author}'s, so bots can't change its ${this.change}`;
	}
	get userMessage() {
		return userText`Bots can only change the title, description or state of what they opened.`;
	}
}

/** The status GitHub refuses a token with when the installation hasn't been granted what it asks for. */
const UNGRANTED_PERMISSIONS_STATUS = 422;

/** `permissions` as GitHub's settings name them, such as "Issues: write". */
function describedPermissions(permissions: GitHub.Permissions): string {
	return Object.entries(permissions)
		.map(([name, level]) => {
			const words = name.replaceAll("_", " ");
			return `${words.charAt(0).toUpperCase()}${words.slice(1)}: ${level}`;
		})
		.join(", ");
}

/**
 * The connection's installation hasn't been granted what a tool needs, as
 * for an app made before Sugabots asked for it: its owner adds it in the
 * app's settings on GitHub, then the account it is installed on accepts it.
 */
export class PermissionNotGranted
	extends Schema.TaggedError<PermissionNotGranted>()("GitHubPermissionNotGranted", {
		permissions: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The connection's GitHub App hasn't been granted ${this.permissions}. Whoever owns the app adds it under Permissions in the app's settings on GitHub, then the account it is installed on accepts the new permissions.`;
	}
	get userMessage() {
		return userText`The pod's GitHub App needs more permissions. Its owner adds them in the app's settings on GitHub.`;
	}
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
