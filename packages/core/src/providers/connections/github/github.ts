import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { type DomainError, userText } from "@sugabots/errors";
import { Clock, DateTime, Effect, ErrorReporter, Redacted, Schema } from "effect";
import type { GitHubAppOwner } from "../../../database/schema.ts";
import type { EgressHttpClient } from "../../network/egress.ts";

/**
 * GitHub's REST API, as a workspace's own GitHub App calls it: made from a
 * manifest, signing requests about itself with its private key, and working
 * on each account it is installed on through that installation's tokens,
 * which last an hour and carry only the repositories and permissions each
 * was asked for.
 */

/** What a GitHub App signs requests about itself with. */
export interface AppIdentity {
	readonly appId: number;
	readonly privateKey: string;
}

/** One of a GitHub App's installations: an account it reaches. */
export interface Installation {
	readonly id: number;
	/** The login of the organization or user whose repositories it reaches. */
	readonly account: string;
}

/** A GitHub App at one of its installations. */
export interface InstalledApp extends AppIdentity {
	readonly installation: Installation;
}

export const API_URL = "https://api.github.com";
export const WEB_URL = "https://github.com";

/**
 * What a workspace's app may be given at install; an app's permissions can
 * later be changed only by its owner, on GitHub. Each token asks for less.
 * Without `workflows`, GitHub refuses a push that changes
 * `.github/workflows`, so a bot can't write CI that runs with the
 * repository's secrets.
 */
const APP_PERMISSIONS = {
	contents: "write",
	pull_requests: "write",
	issues: "write",
	checks: "read",
	actions: "read",
	metadata: "read",
} as const;

export type Permissions = { readonly [K in keyof typeof APP_PERMISSIONS]?: "read" | "write" };

/** What a sandbox's reads are signed in with: enough to clone, fetch, and look at issues, pull requests and CI. */
export const READ_PERMISSIONS: Permissions = {
	contents: "read",
	pull_requests: "read",
	issues: "read",
	checks: "read",
	actions: "read",
	metadata: "read",
};

/**
 * The events a workspace's app is sent, chosen when it is made because an
 * app's events can later be changed only by its owner, on GitHub. Each is
 * covered by a read side of {@link APP_PERMISSIONS}.
 */
const WEBHOOK_EVENTS = [
	"pull_request",
	"pull_request_review",
	"pull_request_review_comment",
	"issue_comment",
	"issues",
	"check_suite",
	"push",
] as const;

/** GitHub's longest app name. */
export const MAX_APP_NAME_LENGTH = 34;

/**
 * A GitHub App's manifest, as GitHub's new-app page takes it. Without a
 * `webhookUrl` the app has no webhook and is sent no events: GitHub refuses a
 * webhook URL it can't reach, even an inactive one.
 */
export function appManifest(input: {
	name: string;
	homepageUrl: string;
	redirectUrl: string;
	setupUrl: string;
	webhookUrl: string | undefined;
}) {
	const webhook = input.webhookUrl
		? { hook_attributes: { url: input.webhookUrl, active: true }, default_events: WEBHOOK_EVENTS }
		: { default_events: [] };
	return {
		name: input.name,
		url: input.homepageUrl,
		redirect_url: input.redirectUrl,
		setup_url: input.setupUrl,
		setup_on_update: true,
		// Private: only the account that owns it can find or install it, so a
		// stranger can't learn the installation's address from it or send it events.
		public: false,
		default_permissions: APP_PERMISSIONS,
		...webhook,
	};
}

/** Where the browser posts a manifest: the person's own account, or an organization they own. */
export function newAppUrl(organization: string | undefined, state: string) {
	const url = new URL(
		organization
			? `${WEB_URL}/organizations/${encodeURIComponent(organization)}/settings/apps/new`
			: `${WEB_URL}/settings/apps/new`,
	);
	url.searchParams.set("state", state);
	return url.toString();
}

/** Where a person installs the app; GitHub then sends them to its setup URL with `state`. */
export function installAppUrl(slug: string, state: string) {
	const url = new URL(`${WEB_URL}/apps/${encodeURIComponent(slug)}/installations/new`);
	url.searchParams.set("state", state);
	return url.toString();
}

/** Where the app's owner changes or deletes it on GitHub. */
export function appSettingsUrl(app: { slug: string; owner: GitHubAppOwner }) {
	const slug = encodeURIComponent(app.slug);
	return app.owner.type === "Organization"
		? `${WEB_URL}/organizations/${encodeURIComponent(app.owner.login)}/settings/apps/${slug}`
		: `${WEB_URL}/settings/apps/${slug}`;
}

const MadeApp = Schema.Struct({
	id: Schema.Int,
	slug: Schema.String,
	name: Schema.String,
	owner: Schema.Struct({
		login: Schema.String,
		type: Schema.Literals(["Organization", "User"]),
	}),
	pem: Schema.String,
	/** Null for an app made without a webhook. */
	webhook_secret: Schema.NullOr(Schema.String),
});

/** Turns the code GitHub gave for an app made from a manifest into the app, its private key and its webhook's secret. */
export const madeApp = (http: EgressHttpClient, code: string) =>
	call(http, "POST", `/app-manifests/${encodeURIComponent(code)}/conversions`, {}).pipe(
		Effect.flatMap(decoded(MadeApp)),
	);

const FoundInstallation = Schema.Struct({
	id: Schema.Int,
	account: Schema.Struct({ login: Schema.String }),
});

/** The app's installation `installationId`; a failure when it is another app's. */
export const installation = (http: EgressHttpClient, app: AppIdentity, installationId: number) =>
	appJwt(app).pipe(
		Effect.flatMap((bearer) =>
			call(http, "GET", `/app/installations/${installationId}`, { bearer }),
		),
		Effect.flatMap(decoded(FoundInstallation)),
		Effect.map((found): Installation => ({ id: found.id, account: found.account.login })),
	);

const AccessToken = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

export interface AccessToken {
	readonly token: string;
	readonly expiresAt: DateTime.Utc;
}

/**
 * A token for the installation's repositories `repositoryIds`, or every one
 * it reaches when they're left out, with `permissions`, lasting an hour.
 * GitHub refuses one for a repository the installation doesn't reach.
 */
export const accessToken = (
	http: EgressHttpClient,
	app: InstalledApp,
	request: { repositoryIds?: readonly number[]; permissions: Permissions },
) =>
	appJwt(app).pipe(
		Effect.flatMap((bearer) =>
			call(http, "POST", `/app/installations/${app.installation.id}/access_tokens`, {
				bearer,
				body: { repository_ids: request.repositoryIds, permissions: request.permissions },
			}),
		),
		Effect.flatMap(decoded(AccessToken)),
		Effect.map(
			(made): AccessToken => ({
				token: made.token,
				expiresAt: DateTime.makeUnsafe(made.expires_at),
			}),
		),
	);

const Repositories = Schema.Struct({
	total_count: Schema.Int,
	repositories: Schema.Array(
		Schema.Struct({ id: Schema.Int, full_name: Schema.String, private: Schema.Boolean }),
	),
});

/** At most this many of an installation's repositories are listed, to pick from. */
const MAX_LISTED_REPOSITORIES = 1_000;
const PAGE_SIZE = 100;

export interface Repository {
	readonly id: number;
	/** `owner/name`, as GitHub writes it. */
	readonly fullName: string;
	readonly private: boolean;
}

/** The repositories the installation reaches. */
export const repositories = (http: EgressHttpClient, app: InstalledApp) =>
	Effect.gen(function* () {
		const { token } = yield* accessToken(http, app, { permissions: { metadata: "read" } });
		const listed: Repository[] = [];
		for (let page = 1; listed.length < MAX_LISTED_REPOSITORIES; page++) {
			const { repositories, total_count } = yield* call(
				http,
				"GET",
				`/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
				{ bearer: token },
			).pipe(Effect.flatMap(decoded(Repositories)));
			listed.push(
				...repositories.map((repository) => ({
					id: repository.id,
					fullName: repository.full_name,
					private: repository.private,
				})),
			);
			if (repositories.length < PAGE_SIZE || listed.length >= total_count) break;
		}
		return listed;
	});

const RepositoryDetails = Schema.Struct({ default_branch: Schema.String });

export const defaultBranch = (http: EgressHttpClient, token: string, repository: string) =>
	call(http, "GET", `/repos/${repository}`, { bearer: token }).pipe(
		Effect.flatMap(decoded(RepositoryDetails)),
		Effect.map((details) => details.default_branch),
	);

const PullRequest = Schema.Struct({ number: Schema.Int, html_url: Schema.String });

export const openPullRequest = (
	http: EgressHttpClient,
	token: string,
	request: {
		repository: string;
		head: string;
		base: string;
		title: string;
		body: string;
		draft: boolean;
	},
) =>
	call(http, "POST", `/repos/${request.repository}/pulls`, {
		bearer: token,
		body: {
			head: request.head,
			base: request.base,
			title: request.title,
			body: request.body,
			draft: request.draft,
		},
	}).pipe(
		Effect.flatMap(decoded(PullRequest)),
		Effect.map((made) => ({ number: made.number, url: made.html_url })),
	);

const PullRequestHead = Schema.Struct({
	node_id: Schema.String,
	draft: Schema.optional(Schema.Boolean),
	head: Schema.Struct({
		ref: Schema.String,
		repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
	}),
});

/** Where pull request `number` comes from: its branch, and the repository that branch is in, if it still exists. */
export const pullRequestHead = (
	http: EgressHttpClient,
	token: string,
	{ repository, number }: { repository: string; number: number },
) =>
	call(http, "GET", `/repos/${repository}/pulls/${number}`, { bearer: token }).pipe(
		Effect.flatMap(decoded(PullRequestHead)),
		Effect.map((pull) => ({
			nodeId: pull.node_id,
			draft: pull.draft ?? false,
			branch: pull.head.ref,
			branchRepository: pull.head.repo?.full_name,
		})),
	);

/** Changes what's given of pull request `number`; the rest stays as it is. */
export const updatePullRequest = (
	http: EgressHttpClient,
	token: string,
	request: {
		repository: string;
		number: number;
		title: string | undefined;
		body: string | undefined;
		base: string | undefined;
		state: "open" | "closed" | undefined;
	},
) =>
	call(http, "PATCH", `/repos/${request.repository}/pulls/${request.number}`, {
		bearer: token,
		body: { title: request.title, body: request.body, base: request.base, state: request.state },
	}).pipe(
		Effect.flatMap(decoded(PullRequest)),
		Effect.map((updated) => ({ number: updated.number, url: updated.html_url })),
	);

const GraphQlReply = Schema.Struct({
	errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});

/** Marks a pull request, by its node id, as a draft or as ready for review: only GitHub's GraphQL API can. */
export const setPullRequestDraft = (
	http: EgressHttpClient,
	token: string,
	{ nodeId, draft }: { nodeId: string; draft: boolean },
) => {
	const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
	return call(http, "POST", "/graphql", {
		bearer: token,
		body: {
			query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`,
			variables: { id: nodeId },
		},
	}).pipe(
		Effect.flatMap(decoded(GraphQlReply)),
		Effect.flatMap(({ errors }) =>
			errors?.length
				? Effect.fail(
						requestFailed({
							status: undefined,
							reason: errors.map((error) => error.message).join(": "),
						}),
					)
				: Effect.void,
		),
	);
};

const Comment = Schema.Struct({ id: Schema.Int, html_url: Schema.String });
const madeComment = (made: typeof Comment.Type) => ({ commentId: made.id, url: made.html_url });

/** Comments on issue or pull request `number`, which share their numbers and comments. */
export const comment = (
	http: EgressHttpClient,
	token: string,
	request: { repository: string; number: number; body: string },
) =>
	call(http, "POST", `/repos/${request.repository}/issues/${request.number}/comments`, {
		bearer: token,
		body: { body: request.body },
	}).pipe(Effect.flatMap(decoded(Comment)), Effect.map(madeComment));

/**
 * A comment's kind, each with its own ids: one in an issue's or pull
 * request's conversation, or one on a pull request's code.
 */
export type CommentKind = "comment" | "code_comment";

const commentPath = (repository: string, kind: CommentKind, commentId: number) =>
	`/repos/${repository}/${kind === "comment" ? "issues" : "pulls"}/comments/${commentId}`;

const Authored = Schema.Struct({ user: Schema.NullOr(Schema.Struct({ login: Schema.String })) });

/** Who wrote a comment, by login; undefined for a deleted account. */
export const commentAuthor = (
	http: EgressHttpClient,
	token: string,
	request: { repository: string; kind: CommentKind; commentId: number },
) =>
	call(http, "GET", commentPath(request.repository, request.kind, request.commentId), {
		bearer: token,
	}).pipe(
		Effect.flatMap(decoded(Authored)),
		Effect.map((found) => found.user?.login),
	);

export const editComment = (
	http: EgressHttpClient,
	token: string,
	request: { repository: string; kind: CommentKind; commentId: number; body: string },
) =>
	call(http, "PATCH", commentPath(request.repository, request.kind, request.commentId), {
		bearer: token,
		body: { body: request.body },
	}).pipe(Effect.flatMap(decoded(Comment)), Effect.map(madeComment));

export const deleteComment = (
	http: EgressHttpClient,
	token: string,
	request: { repository: string; kind: CommentKind; commentId: number },
) =>
	call(http, "DELETE", commentPath(request.repository, request.kind, request.commentId), {
		bearer: token,
	}).pipe(Effect.asVoid);

/** The reactions GitHub has, by its names for them. */
export const REACTIONS = [
	"+1",
	"-1",
	"laugh",
	"confused",
	"heart",
	"hooray",
	"rocket",
	"eyes",
] as const;
export type Reaction = (typeof REACTIONS)[number];

/** What a reaction is on: an issue or pull request, which share their numbers, or a comment. */
export type ReactionSubject =
	| { readonly kind: "issue"; readonly number: number }
	| { readonly kind: CommentKind; readonly commentId: number };

export const react = (
	http: EgressHttpClient,
	token: string,
	request: { repository: string; subject: ReactionSubject; reaction: Reaction },
) => {
	const { repository, subject } = request;
	const path =
		subject.kind === "issue"
			? `/repos/${repository}/issues/${subject.number}`
			: commentPath(repository, subject.kind, subject.commentId);
	return call(http, "POST", `${path}/reactions`, {
		bearer: token,
		body: { content: request.reaction },
	}).pipe(Effect.asVoid);
};

const Issue = Schema.Struct({
	number: Schema.Int,
	html_url: Schema.String,
	user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
	/** Present when the issue is a pull request. */
	pull_request: Schema.optional(Schema.Unknown),
});

export const openIssue = (
	http: EgressHttpClient,
	token: string,
	request: {
		repository: string;
		title: string;
		body: string;
		labels: readonly string[] | undefined;
		assignees: readonly string[] | undefined;
	},
) =>
	call(http, "POST", `/repos/${request.repository}/issues`, {
		bearer: token,
		body: {
			title: request.title,
			body: request.body,
			labels: request.labels,
			assignees: request.assignees,
		},
	}).pipe(
		Effect.flatMap(decoded(Issue)),
		Effect.map((made) => ({ number: made.number, url: made.html_url })),
	);

/** Who opened issue or pull request `number`, by login, and whether it is a pull request. */
export const issueAuthor = (
	http: EgressHttpClient,
	token: string,
	{ repository, number }: { repository: string; number: number },
) =>
	call(http, "GET", `/repos/${repository}/issues/${number}`, { bearer: token }).pipe(
		Effect.flatMap(decoded(Issue)),
		Effect.map((found) => ({
			author: found.user?.login,
			isPullRequest: found.pull_request !== undefined,
		})),
	);

/** Why an issue was closed, by GitHub's names. */
export type ClosedReason = "completed" | "not_planned" | "duplicate";

/**
 * Changes what's given of issue or pull request `number`; the rest stays as
 * it is. `labels` and `assignees` each replace the whole set.
 */
export const updateIssue = (
	http: EgressHttpClient,
	token: string,
	request: {
		repository: string;
		number: number;
		title: string | undefined;
		body: string | undefined;
		state: "open" | "closed" | undefined;
		closedReason: ClosedReason | undefined;
		labels: readonly string[] | undefined;
		assignees: readonly string[] | undefined;
	},
) =>
	call(http, "PATCH", `/repos/${request.repository}/issues/${request.number}`, {
		bearer: token,
		body: {
			title: request.title,
			body: request.body,
			state: request.state,
			state_reason: request.closedReason,
			labels: request.labels,
			assignees: request.assignees,
		},
	}).pipe(
		Effect.flatMap(decoded(Issue)),
		Effect.map((updated) => ({ number: updated.number, url: updated.html_url })),
	);

/** What a review says of a pull request as a whole. */
export type ReviewVerdict = "approve" | "request_changes" | "comment";

const REVIEW_EVENTS: Readonly<Record<ReviewVerdict, string>> = {
	approve: "APPROVE",
	request_changes: "REQUEST_CHANGES",
	comment: "COMMENT",
};

/** A review's comment on a line of a file in the diff, or on the lines from `startLine` to `line`. */
export interface LineComment {
	readonly path: string;
	readonly line: number;
	readonly startLine: number | undefined;
	/** Which version of the file the lines are in: the base's for removed lines, the head's otherwise. */
	readonly side: "base" | "head";
	readonly body: string;
}

const Review = Schema.Struct({ id: Schema.Int, html_url: Schema.String });

/** Reviews pull request `number` at `commit`, or at its newest commit when left out. */
export const reviewPullRequest = (
	http: EgressHttpClient,
	token: string,
	request: {
		repository: string;
		number: number;
		verdict: ReviewVerdict;
		body: string;
		commit: string | undefined;
		comments: readonly LineComment[];
	},
) => {
	const sideOf = (side: LineComment["side"]) => (side === "base" ? "LEFT" : "RIGHT");
	return call(http, "POST", `/repos/${request.repository}/pulls/${request.number}/reviews`, {
		bearer: token,
		body: {
			event: REVIEW_EVENTS[request.verdict],
			body: request.body,
			commit_id: request.commit,
			comments: request.comments.map((comment) => ({
				path: comment.path,
				line: comment.line,
				side: sideOf(comment.side),
				start_line: comment.startLine,
				start_side: comment.startLine === undefined ? undefined : sideOf(comment.side),
				body: comment.body,
			})),
		},
	}).pipe(
		Effect.flatMap(decoded(Review)),
		Effect.map((made) => ({ reviewId: made.id, url: made.html_url })),
	);
};

/** Replies in the thread of `commentId`, a comment on pull request `number`'s code. */
export const replyToCodeComment = (
	http: EgressHttpClient,
	token: string,
	request: { repository: string; number: number; commentId: number; body: string },
) =>
	call(
		http,
		"POST",
		`/repos/${request.repository}/pulls/${request.number}/comments/${request.commentId}/replies`,
		{ bearer: token, body: { body: request.body } },
	).pipe(Effect.flatMap(decoded(Comment)), Effect.map(madeComment));

/** How long an app's own token lasts; GitHub takes at most ten minutes. */
const APP_JWT_SECONDS = 9 * 60;
/** Back-dated, as GitHub suggests, so a clock a little ahead of GitHub's isn't refused. */
const CLOCK_ALLOWANCE_SECONDS = 60;

/** The app's own token, signed with its private key, for requests about the app and its installations. */
export const appJwt = (app: AppIdentity) =>
	Effect.map(Clock.currentTimeMillis, (nowMilliseconds) => {
		const now = Math.floor(nowMilliseconds / 1000);
		const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
		const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
			iat: now - CLOCK_ALLOWANCE_SECONDS,
			exp: now + APP_JWT_SECONDS,
			iss: String(app.appId),
		})}`;
		const signature = createSign("RSA-SHA256").update(unsigned).sign(app.privateKey, "base64url");
		return `${unsigned}.${signature}`;
	});

const ErrorBody = Schema.Struct({
	message: Schema.String,
	errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.String) }))),
});

/** A request to GitHub's API, signed in with `bearer`, answering with the decoded JSON body. */
export function call(
	http: EgressHttpClient,
	method: "GET" | "POST" | "PATCH" | "DELETE",
	path: string,
	options: { bearer?: string; body?: unknown },
) {
	return Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: (signal) =>
				http(`${API_URL}${path}`, {
					method,
					signal,
					headers: {
						accept: "application/vnd.github+json",
						"x-github-api-version": "2022-11-28",
						...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
						...(options.body === undefined ? {} : { "content-type": "application/json" }),
					},
					body: options.body === undefined ? undefined : JSON.stringify(options.body),
				}),
			catch: (cause) => requestFailed({ status: undefined, reason: String(cause) }),
		});
		const text = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: (cause) => requestFailed({ status: response.status, reason: String(cause) }),
		});
		const body = parsedJson(text);
		if (response.ok) return body;
		const failure = Schema.decodeUnknownOption(ErrorBody)(body);
		const reason =
			failure._tag === "Some"
				? [failure.value.message, ...(failure.value.errors ?? []).flatMap((e) => e.message ?? [])]
						.filter(Boolean)
						.join(": ")
				: response.statusText;
		return yield* requestFailed({ status: response.status, reason });
	});
}

export function parsedJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export const decoded =
	<S extends Schema.Decoder<unknown>>(schema: S) =>
	(body: unknown) =>
		Schema.decodeUnknownEffect(schema)(body).pipe(
			Effect.mapError((cause) =>
				requestFailed({ status: undefined, reason: `Unexpected reply: ${cause}` }),
			),
		);

function requestFailed(failure: { status: number | undefined; reason: string }) {
	return new GitHubRequestFailed(failure);
}

/**
 * Whether `signature`, GitHub's `X-Hub-Signature-256` header, is the
 * HMAC-SHA256 of `body` under the app's webhook secret.
 */
export function signedDelivery(secret: string, body: string, signature: string | undefined) {
	if (!signature) return false;
	const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
	const given = Buffer.from(signature);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/** What git signs in with, as `username` and `token` over HTTP basic authentication. */
export interface GitCredential {
	readonly username: string;
	readonly token: string;
}

/** The `Authorization` header's value that signs git in over HTTP with `credential`. */
export function basicAuthorizationValue({ username, token }: GitCredential) {
	return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
}

/** {@link basicAuthorizationValue}, kept out of logs. */
export function redactedBasicAuthorization(credential: GitCredential) {
	return Redacted.make(basicAuthorizationValue(credential));
}

/**
 * GitHub refused a request or couldn't be reached. `reason` is GitHub's own
 * words, for the logs and for the bot whose call it was; people are told
 * only that GitHub refused.
 */
export class GitHubRequestFailed
	extends Schema.TaggedError<GitHubRequestFailed>()("GitHubRequestFailed", {
		status: Schema.UndefinedOr(Schema.Int),
		reason: Schema.String,
	})
	implements DomainError
{
	override readonly [ErrorReporter.severity] = "Warn" as const;
	get isRetryable() {
		return this.status === undefined || this.status >= 500;
	}
	override get message() {
		return `GitHub ${this.status ?? "unreachable"}: ${this.reason}`;
	}
	get userMessage() {
		return this.isRetryable
			? userText`We couldn't reach GitHub. Try again in a few minutes.`
			: userText`GitHub refused the workspace's sign-in. A workspace admin can check it in the workspace's Git settings.`;
	}
}
