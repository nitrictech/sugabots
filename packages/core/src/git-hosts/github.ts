import { createSign } from "node:crypto";
import { Clock, Data, DateTime, Effect, Schema } from "effect";
import type { EgressHttpClient } from "../providers/network/egress.ts";
import { type UserFacing, UserMessage } from "../user-message.ts";
import type { GitHubAppCredential } from "./credential.ts";

/**
 * GitHub's REST API, as a workspace's own GitHub App calls it: made from a
 * manifest, authenticated by its private key, and working on the account it
 * is installed on through installation tokens, which last an hour and carry
 * only the repositories and permissions each was asked for.
 */

export const API_URL = "https://api.github.com";
export const WEB_URL = "https://github.com";

/**
 * What a workspace's app may be given at install. Tokens ask for less: a
 * sandbox's reads get the `read` side, and pushes and pull requests only
 * their own. Without `workflows`, GitHub refuses a push that changes
 * `.github/workflows`, so an agent can't write CI that runs with the
 * repository's secrets.
 */
export const APP_PERMISSIONS = {
	contents: "write",
	pull_requests: "write",
	issues: "read",
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

/** A GitHub App's manifest, as GitHub's new-app page takes it. */
export function appManifest(input: {
	name: string;
	homepageUrl: string;
	redirectUrl: string;
	setupUrl: string;
}) {
	return {
		name: input.name,
		url: input.homepageUrl,
		redirect_url: input.redirectUrl,
		setup_url: input.setupUrl,
		setup_on_update: true,
		public: false,
		default_permissions: APP_PERMISSIONS,
		default_events: [],
		// Sugabots doesn't take GitHub's events yet.
		hook_attributes: { url: input.homepageUrl, active: false },
	};
}

/** GitHub's longest app name. */
export const MAX_APP_NAME_LENGTH = 34;

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

/** Where a person installs the app; GitHub sends them to its setup URL with `state` after. */
export function installAppUrl(slug: string, state: string) {
	const url = new URL(`${WEB_URL}/apps/${encodeURIComponent(slug)}/installations/new`);
	url.searchParams.set("state", state);
	return url.toString();
}

/** Where its owner changes or deletes the app on GitHub. */
export function appSettingsUrl(slug: string) {
	return `${WEB_URL}/apps/${encodeURIComponent(slug)}`;
}

const MadeApp = Schema.Struct({
	id: Schema.Int,
	slug: Schema.String,
	name: Schema.String,
	pem: Schema.String,
});

/** Turns the code GitHub gave for an app made from a manifest into the app and its private key. */
export const madeApp = (http: EgressHttpClient, code: string) =>
	call(http, "POST", `/app-manifests/${encodeURIComponent(code)}/conversions`, {}).pipe(
		Effect.flatMap(decoded(MadeApp)),
	);

const Installation = Schema.Struct({
	id: Schema.Int,
	account: Schema.Struct({ login: Schema.String }),
});

/** The app's installation `installationId`; a failure when it is another app's. */
export const installation = (
	http: EgressHttpClient,
	app: GitHubAppCredential,
	installationId: number,
) =>
	appJwt(app).pipe(
		Effect.flatMap((bearer) =>
			call(http, "GET", `/app/installations/${installationId}`, { bearer }),
		),
		Effect.flatMap(decoded(Installation)),
	);

const AccessToken = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

export interface AccessToken {
	readonly token: string;
	readonly expiresAt: DateTime.Utc;
}

/**
 * A token for the installation's `repositories` (names without the owner),
 * or every one it reaches when they're left out, with `permissions`, lasting
 * an hour. GitHub refuses one for a repository the installation doesn't reach.
 */
export const accessToken = (
	http: EgressHttpClient,
	app: InstalledApp,
	request: { repositories?: readonly string[]; permissions: Permissions },
) =>
	appJwt(app).pipe(
		Effect.flatMap((bearer) =>
			call(http, "POST", `/app/installations/${app.installationId}/access_tokens`, {
				bearer,
				body: { repositories: request.repositories, permissions: request.permissions },
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

export type InstalledApp = GitHubAppCredential & { readonly installationId: number };

const Repositories = Schema.Struct({
	total_count: Schema.Int,
	repositories: Schema.Array(Schema.Struct({ full_name: Schema.String, private: Schema.Boolean })),
});

/** At most this many of an installation's repositories are listed, to pick from. */
const MAX_LISTED_REPOSITORIES = 1_000;
const PAGE_SIZE = 100;

export interface Repository {
	readonly fullName: string;
	readonly private: boolean;
}

/** The repositories the installation reaches, by full name. */
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

/** How long an app's own token lasts; GitHub takes at most ten minutes. */
const APP_JWT_SECONDS = 9 * 60;
/** Back-dated, as GitHub suggests, so a clock a little ahead of GitHub's isn't refused. */
const CLOCK_ALLOWANCE_SECONDS = 60;

/** The app's own token, signed with its private key, for calls about the app and its installations. */
const appJwt = (app: GitHubAppCredential) =>
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

function call(
	http: EgressHttpClient,
	method: "GET" | "POST",
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
			catch: (cause) => new GitHubFailed({ status: undefined, reason: String(cause) }),
		});
		const body: unknown = yield* Effect.promise(() => response.json().catch(() => undefined));
		if (response.ok) return body;
		const failure = Schema.decodeUnknownOption(ErrorBody)(body);
		const reason =
			failure._tag === "Some"
				? [failure.value.message, ...(failure.value.errors ?? []).flatMap((e) => e.message ?? [])]
						.filter(Boolean)
						.join(": ")
				: response.statusText;
		return yield* new GitHubFailed({ status: response.status, reason });
	});
}

const decoded =
	<S extends Schema.Decoder<unknown>>(schema: S) =>
	(body: unknown) =>
		Schema.decodeUnknownEffect(schema)(body).pipe(
			Effect.mapError(
				(cause) => new GitHubFailed({ status: undefined, reason: `Unexpected reply: ${cause}` }),
			),
		);

/**
 * GitHub refused a call or couldn't be reached. `reason` is GitHub's own
 * words, for the logs and for the agent whose call it was; people are told
 * only that GitHub refused.
 */
export class GitHubFailed
	extends Data.TaggedError("GitHubFailed")<{
		status: number | undefined;
		reason: string;
	}>
	implements UserFacing
{
	override get message() {
		return `GitHub ${this.status ?? "unreachable"}: ${this.reason}`;
	}

	get userMessage() {
		return UserMessage.of`GitHub refused the workspace's app. Check that it's still installed, on GitHub.`;
	}
}
