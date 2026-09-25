import { Schema } from "effect";
import { providerStatusSchema, providerUrlSchema } from "./model-providers.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * GitHub: how a workspace's agents reach the repositories their pods work on.
 *
 * One connection per workspace, by one of two methods:
 * - `app`: a GitHub App the workspace registers for itself through GitHub's
 *   manifest flow and installs on its account or organisation. Sugabots mints
 *   short-lived installation tokens, each narrowed to the repositories and
 *   access a job needs. The recommended method.
 * - `token`: a fine-grained personal access token an admin pastes, for a quick
 *   start or where registering an app isn't possible.
 * Neither is ever given to a sandbox: credentials are added to the sandbox's
 * git requests on the way out, and only for the repositories its pod has.
 */

export const githubConnectionMethodSchema = Schema.Literals(["app", "token"]);
export type GithubConnectionMethod = typeof githubConnectionMethodSchema.Type;

/** github.com's addresses, until an admin points the connection at GitHub Enterprise Server. */
export const GITHUB_DEFAULT_API_URL = "https://api.github.com";
export const GITHUB_DEFAULT_GIT_HOST = "github.com";

const gitHostSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(253),
	Schema.isPattern(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i, { message: "A host name, such as github.com" }),
);

const tokenSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

export const githubConnectionSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	method: githubConnectionMethodSchema,
	apiBaseUrl: providerUrlSchema,
	/** Where repositories are cloned from, e.g. github.com. */
	gitHost: Schema.String,
	hasToken: Schema.Boolean,
	/**
	 * For a token, whose it is, from the last successful test. For an app, the
	 * account or organisation it is installed on.
	 */
	accountLogin: Schema.NullOr(Schema.String),
	/** The app's address on GitHub, e.g. `sugabots-acme`. Null for a token. */
	appSlug: Schema.NullOr(Schema.String),
	/** Whether the app is installed yet. Always true for a token. */
	installed: Schema.Boolean,
	status: providerStatusSchema,
	lastTestedAt: Schema.NullOr(isoTimestampSchema),
	lastTestError: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
});

export type GithubConnection = typeof githubConnectionSchema.Type;

/** A connection by token. An app connection is made through the `startApp` endpoint instead. */
export const newGithubConnectionSchema = Schema.Struct({
	method: Schema.Literal("token"),
	token: tokenSchema,
	apiBaseUrl: Schema.optional(providerUrlSchema),
	gitHost: Schema.optional(gitHostSchema),
});

export type NewGithubConnection = typeof newGithubConnectionSchema.Type;

export const githubConnectionUpdateSchema = Schema.Struct({
	token: Schema.optional(tokenSchema),
	apiBaseUrl: Schema.optional(providerUrlSchema),
	gitHost: Schema.optional(gitHostSchema),
}).check(
	Schema.makeFilter((value) => Object.keys(value).length > 0, { message: "Nothing to change" }),
);

export type GithubConnectionUpdate = typeof githubConnectionUpdateSchema.Type;

export const githubConnectionResponseSchema = Schema.Struct({
	connection: Schema.NullOr(githubConnectionSchema),
	/**
	 * For an app: where to install it, or change which repositories it has,
	 * carrying state that brings the browser back here. Null for a token.
	 */
	installUrl: Schema.NullOr(Schema.String),
});

export const githubConnectionTestResultSchema = Schema.Struct({
	reachable: Schema.Boolean,
	/** Whose token it is, when GitHub accepted it. */
	login: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
});

export type GithubConnectionTestResult = typeof githubConnectionTestResultSchema.Type;

/** `owner/name`, as GitHub writes a repository's full name. */
export const repositoryFullNameSchema = Schema.Trim.check(
	Schema.isMaxLength(200),
	Schema.isPattern(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, { message: "owner/repository" }),
);

/** A repository a pod's agents may check out, with the token's help if it is private. */
export const podRepositorySchema = Schema.Struct({
	id: uuidSchema,
	podId: uuidSchema,
	fullName: Schema.String,
	defaultBranch: Schema.String,
	private: Schema.Boolean,
	createdAt: isoTimestampSchema,
});

export type PodRepository = typeof podRepositorySchema.Type;

export const newPodRepositorySchema = Schema.Struct({ fullName: repositoryFullNameSchema });

/** A repository the workspace's GitHub connection can reach, offered for adding to a pod. */
export const availableRepositorySchema = Schema.Struct({
	fullName: Schema.String,
	private: Schema.Boolean,
	defaultBranch: Schema.String,
});

export type AvailableRepository = typeof availableRepositorySchema.Type;

export type NewPodRepository = typeof newPodRepositorySchema.Type;

/** Where GitHub should register the app: the admin's own account, or an organisation they own. */
export const githubAppStartSchema = Schema.Struct({
	organization: Schema.optional(
		Schema.Trim.check(
			Schema.isMaxLength(100),
			Schema.isPattern(/^[A-Za-z0-9-]*$/, { message: "An organisation's login" }),
		),
	),
});

export type GithubAppStart = typeof githubAppStartSchema.Type;

/**
 * What the web app posts to GitHub to register the app: GitHub's manifest
 * flow is a form post from the browser, not an API call.
 */
export const githubAppManifestSchema = Schema.Struct({
	/** Where the form is posted. */
	actionUrl: Schema.String,
	/** The manifest, as the JSON string the form's `manifest` field carries. */
	manifest: Schema.String,
});

export type GithubAppManifest = typeof githubAppManifestSchema.Type;

/** Where in a workspace the browser lands once the app is made and installed: its GitHub settings. */
export const GITHUB_APP_RETURN_PATH = "/settings/github";
