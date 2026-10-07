import { Schema } from "effect";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Where GitHub sends the browser, under the API, once a workspace's app is
 * made from its manifest, and once it is installed. Each answers with a
 * redirect to {@link GIT_HOSTS_RETURN_PATH} in the web app.
 */
export const GITHUB_APP_MADE_PATH = "/git-hosts/github/made";
export const GITHUB_APP_INSTALLED_PATH = "/git-hosts/github/installed";

/** Where, under the API, a git host sends its events: the host's id follows. */
export const GIT_HOST_WEBHOOK_PATH = "/hooks/git-hosts";

/**
 * Where the web app takes the browser back from GitHub: `workspace` names
 * the workspace, and `git_host_error`, when set, a {@link GitHostSetupFailure}.
 */
export const GIT_HOSTS_RETURN_PATH = "/git-hosts/return";

export const gitHostSetupFailureSchema = Schema.Literals([
	/** The link was old, altered, or someone else's. */
	"expired",
	/** GitHub refused or couldn't be reached. */
	"github",
	/** The person declined on GitHub's page. */
	"cancelled",
]);

export type GitHostSetupFailure = typeof gitHostSetupFailureSchema.Type;

/** A place a workspace keeps code, and what Sugabots works there as. */
export const gitHostSchema = Schema.Struct({
	id: uuidSchema,
	kind: Schema.Literal("github"),
	/** The GitHub App's name. */
	name: Schema.String,
	/** The organization or user it is installed on; null until it is. */
	account: Schema.NullOr(Schema.String),
	/** Where the app's owner changes or deletes it at the host. */
	settingsUrl: Schema.String,
	createdAt: isoTimestampSchema,
});

export type GitHost = typeof gitHostSchema.Type;

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

/** What the browser posts to GitHub to make the app: `manifest` as a form field to `url`. */
export const gitHubAppFormSchema = Schema.Struct({ url: Schema.String, manifest: Schema.String });

export type GitHubAppForm = typeof gitHubAppFormSchema.Type;

/** Where the browser goes to install an app that isn't yet. */
export const gitHubAppInstallSchema = Schema.Struct({ url: Schema.String });

/** A repository's full name at its host, `owner/name`. */
export const repositoryNameSchema = Schema.String.check(
	Schema.isMaxLength(140),
	Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/, {
		message: "Enter a repository as owner/name",
	}),
);

/** The repositories a pod's agents work on. */
export const podRepositoriesSchema = Schema.Struct({
	repositories: Schema.Array(
		Schema.Struct({
			gitHostId: uuidSchema,
			repository: repositoryNameSchema,
			/** Who added it; null once they've left. */
			addedByName: Schema.NullOr(Schema.String),
			addedAt: isoTimestampSchema,
		}),
	),
});

export type PodRepositories = typeof podRepositoriesSchema.Type;

/** Repositories the workspace's git hosts reach, which a pod may add. */
export const availableRepositoriesSchema = Schema.Array(
	Schema.Struct({
		gitHostId: uuidSchema,
		repository: repositoryNameSchema,
		private: Schema.Boolean,
	}),
);

export type AvailableRepositories = typeof availableRepositoriesSchema.Type;

export const podRepositorySchema = Schema.Struct({
	gitHostId: uuidSchema,
	repository: repositoryNameSchema,
});

export type PodRepository = typeof podRepositorySchema.Type;
