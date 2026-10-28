import { type DomainError, userText } from "@sugabots/errors";
import { Effect, ErrorReporter, Schema } from "effect";
import type { ConnectionRow, GitHubConnectionSettings } from "../../../database/schema.ts";
import type { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import type { EgressHttpClient } from "../../network/egress.ts";
import * as GitHub from "./github.ts";
import * as GitHubReads from "./github-reads.ts";

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
			this.tokenFor(repository, { contents: "write" }),
			(token): GitHub.GitCredential => ({ username: TOKEN_USERNAME, token }),
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
		const { http } = this;
		const granted = this.tokenFor(request.repository, {
			pull_requests: "write",
			contents: "read",
		});
		return Effect.gen(function* () {
			const token = yield* granted;
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
		const { http } = this;
		const granted = this.tokenFor(request.repository, {
			pull_requests: "write",
			contents: "read",
		});
		return Effect.gen(function* () {
			const token = yield* granted;
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
		return Effect.flatMap(this.tokenFor(request.repository, { pull_requests: "write" }), (token) =>
			GitHub.comment(this.http, token, request),
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
				(failure) =>
					failure.status === UNGRANTED_PERMISSIONS_STATUS &&
					UNGRANTED_PERMISSIONS_REASON.test(failure.reason),
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
		subject: GitHub.ReactionSubject;
		reaction: GitHub.Reaction;
	}) {
		const { kind } = request.subject;
		const onPullRequest = kind === "pull_request" || kind === "code_comment";
		return Effect.flatMap(
			this.tokenFor(
				request.repository,
				onPullRequest ? { pull_requests: "write" } : { issues: "write" },
			),
			(token) => GitHub.react(this.http, token, request),
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
				const { author } = yield* GitHub.findComment(http, token, request);
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
	 * Changes an issue, or labels and assigns a pull request, whose other
	 * changes are {@link updatePullRequest}'s alone. Bots label, assign, close
	 * and reopen anyone's issue, but change the title or description only of
	 * one the connection's app opened. What isn't given stays as it is.
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
						const found = yield* GitHub.findIssue(http, token, request);
						if (found.isPullRequest) {
							return yield* new IssueIsPullRequest({ number: request.number });
						}
						const author = found.author ?? "ghost";
						if (changesWords && author !== botLogin) {
							return yield* new NotBotIssue({ number: request.number, author });
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

	/**
	 * Replies in the thread of a comment on pull request `number`'s code,
	 * which may itself be a reply: GitHub takes replies only to a thread's first.
	 */
	replyToCodeComment(request: {
		repository: string;
		number: number;
		commentId: number;
		body: string;
	}) {
		const { http } = this;
		return Effect.flatMap(this.tokenFor(request.repository, { pull_requests: "write" }), (token) =>
			Effect.gen(function* () {
				const { threadId } = yield* GitHub.findComment(http, token, {
					repository: request.repository,
					kind: "code_comment",
					commentId: request.commentId,
				});
				return yield* GitHub.replyToCodeComment(http, token, { ...request, commentId: threadId });
			}),
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

/** An issue someone else opened, whose title and description bots may not change. */
export class NotBotIssue
	extends Schema.TaggedError<NotBotIssue>()("NotBotIssue", {
		number: Schema.Int,
		author: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `#${this.number} is ${this.author}'s, so bots can't change its title or description`;
	}
	get userMessage() {
		return userText`Bots can only change the title or description of issues they opened.`;
	}
}

/** A pull request given where an issue is changed, though only its labels and assignees may be there. */
export class IssueIsPullRequest
	extends Schema.TaggedError<IssueIsPullRequest>()("IssueIsPullRequest", {
		number: Schema.Int,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `#${this.number} is a pull request, whose title, description and state are changed as a pull request`;
	}
	get userMessage() {
		return userText`Change a pull request's title, description or state as a pull request.`;
	}
}

/**
 * The status and words GitHub refuses a token with when the installation
 * hasn't been granted what it asks for; it refuses others, such as for a
 * repository it no longer reaches, with the same status.
 */
const UNGRANTED_PERMISSIONS_STATUS = 422;
const UNGRANTED_PERMISSIONS_REASON = /permissions requested are not granted/i;

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
