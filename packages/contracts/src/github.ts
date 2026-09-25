import { Schema } from "effect";
import { providerStatusSchema, providerUrlSchema } from "./model-providers.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * GitHub: how a workspace's agents reach the repositories their pods work on.
 *
 * One connection per workspace. For now it is a token an admin pastes (a
 * fine-grained personal access token); a GitHub App each installation
 * registers for itself comes later, behind the same connection. The token is
 * never given to a sandbox: it is added to the sandbox's git requests on the
 * way out, and only for the repositories its pod has.
 */

export const githubConnectionMethodSchema = Schema.Literals(["token"]);
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
	/** Whose token it is, from the last successful test. */
	accountLogin: Schema.NullOr(Schema.String),
	status: providerStatusSchema,
	lastTestedAt: Schema.NullOr(isoTimestampSchema),
	lastTestError: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
});

export type GithubConnection = typeof githubConnectionSchema.Type;

export const newGithubConnectionSchema = Schema.Struct({
	method: githubConnectionMethodSchema,
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

export type NewPodRepository = typeof newPodRepositorySchema.Type;
