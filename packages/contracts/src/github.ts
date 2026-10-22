import { Schema } from "effect";
import { isoTimestampSchema } from "./timestamps.ts";

/**
 * Where GitHub sends the browser, under the API, once a pod's GitHub App is
 * made from its manifest, and once it is installed. Each answers with a
 * redirect to {@link GITHUB_SETUP_RETURN_PATH} in the web app.
 */
export const GITHUB_APP_MADE_PATH = "/connections/github/made";
export const GITHUB_APP_INSTALLED_PATH = "/connections/github/installed";

/** Where, under the API, a GitHub connection's app sends its events: the connection's id follows. */
export const GITHUB_WEBHOOK_PATH = "/hooks/connections";

/**
 * Where the web app takes the browser back from GitHub: `workspace` and
 * `pod` name the pod, `connection` its GitHub connection once it is made,
 * and `github_error`, when set, a {@link GitHubSetupFailure}.
 */
export const GITHUB_SETUP_RETURN_PATH = "/connections/github/return";

export const gitHubSetupFailureSchema = Schema.Literals([
	/** The link was old, altered, or someone else's. */
	"expired",
	/** GitHub refused or couldn't be reached. */
	"github",
	/** The person declined on GitHub's page. */
	"cancelled",
]);

export type GitHubSetupFailure = typeof gitHubSetupFailureSchema.Type;

/**
 * A GitHub organization's login, for an app the organization owns; left out
 * for one the person owns.
 */
export const newGitHubAppSchema = Schema.Struct({
	organization: Schema.optional(
		Schema.String.check(
			Schema.isMaxLength(39),
			Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, {
				message: "Enter a GitHub organization's name, as in its github.com address",
			}),
		),
	),
});

export type NewGitHubApp = typeof newGitHubAppSchema.Type;

/** What the browser posts to GitHub to make the app: `manifest` as a form field, to `url`. */
export const gitHubAppFormSchema = Schema.Struct({ url: Schema.String, manifest: Schema.String });

export type GitHubAppForm = typeof gitHubAppFormSchema.Type;

/** Where the browser goes to install the connection's app, or to change which repositories it reaches. */
export const gitHubAppInstallSchema = Schema.Struct({ url: Schema.String });

/** A repository's path, as GitHub writes it: `owner/name`. */
export const repositoryPathSchema = Schema.String.check(
	Schema.isMaxLength(255),
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/, {
		message: "Enter a repository as owner/name",
	}),
);

/** A repository the connection's app reaches, which the connection may work on. */
export const accountRepositorySchema = Schema.Struct({
	repository: repositoryPathSchema,
	private: Schema.Boolean,
});

export type AccountRepository = typeof accountRepositorySchema.Type;

/**
 * The repositories a GitHub connection's tools work on, the account they
 * belong to, and where its app is changed or deleted on GitHub.
 */
export const connectionRepositoriesSchema = Schema.Struct({
	/** Null until the connection's app is installed. */
	account: Schema.NullOr(Schema.String),
	repositories: Schema.Array(
		Schema.Struct({
			repository: repositoryPathSchema,
			/** Who added it; null once they've left. */
			addedByName: Schema.NullOr(Schema.String),
			addedAt: isoTimestampSchema,
		}),
	),
});

export type ConnectionRepositories = typeof connectionRepositoriesSchema.Type;

/** A repository to add to or remove from a GitHub connection. */
export const connectionRepositoryChangeSchema = Schema.Struct({ repository: repositoryPathSchema });
