import { Schema } from "effect";
import { uuidSchema } from "./uuid.ts";

/**
 * Where GitHub sends the browser, under the API, once a project's GitHub App is
 * made from its manifest, and once it is installed. Each answers with a
 * redirect to {@link GITHUB_SETUP_RETURN_PATH} in the web app.
 */
export const GITHUB_APP_MADE_PATH = "/connectors/github/made";
export const GITHUB_APP_INSTALLED_PATH = "/connectors/github/installed";

/** Where, under the API, a GitHub connector's app sends its events: the connector's id follows. */
export const GITHUB_WEBHOOK_PATH = "/webhooks/connectors";

/**
 * Where the web app takes the browser back from GitHub: `workspace` and
 * `project` name the project, `connector` its GitHub app once it is made,
 * and `github_error`, when set, a {@link GitHubSetupFailure}.
 */
export const GITHUB_SETUP_RETURN_PATH = "/connectors/github/return";

const gitHubSetupFailureSchema = Schema.Literals([
	/** The link was old, altered, or someone else's. */
	"expired",
	/** GitHub refused or couldn't be reached. */
	"github",
	/** The member declined on GitHub's page. */
	"cancelled",
]);

export type GitHubSetupFailure = typeof gitHubSetupFailureSchema.Type;

/** The project being connected to GitHub, by its workspace and its own id. */
const setupProjectSchema = Schema.Struct({ workspaceId: uuidSchema, projectId: uuidSchema });

/**
 * Where a step of setting up a project's GitHub app goes next: on to GitHub,
 * back to the project's GitHub app, or back with why it stopped. A failure
 * names the project only when the step was the caller's.
 */
export const gitHubSetupOutcomeSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("next"), url: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("done"), at: setupProjectSchema, connectorId: uuidSchema }),
	Schema.Struct({
		kind: Schema.Literal("failed"),
		at: Schema.UndefinedOr(setupProjectSchema),
		failure: gitHubSetupFailureSchema,
	}),
]);

export type GitHubSetupOutcome = typeof gitHubSetupOutcomeSchema.Type;

/**
 * A GitHub organization's login, for an app the organization owns; left out
 * for one the member owns.
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

/** What the browser posts to GitHub to make the app: `manifest` as a form field, to `url`. */
export const gitHubAppFormSchema = Schema.Struct({ url: Schema.String, manifest: Schema.String });

export type GitHubAppForm = typeof gitHubAppFormSchema.Type;

/** Where the browser goes to install the connector's app, or to change which repositories it reaches. */
export const gitHubAppInstallSchema = Schema.Struct({ url: Schema.String });

/** A repository's path, as GitHub writes it: `owner/name`. */
export const repositoryPathSchema = Schema.String.check(
	Schema.isMaxLength(255),
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/, {
		message: "Enter a repository as owner/name",
	}),
);

/** A repository the connector's app reaches, which the connector may work on. */
export const accountRepositorySchema = Schema.Struct({
	repository: repositoryPathSchema,
	private: Schema.Boolean,
});

export type AccountRepository = typeof accountRepositorySchema.Type;

/**
 * What happens at a repository that can start an automation: a pull request
 * opened (or reopened, or marked ready for review), a review of one, a
 * comment on one or on its code, an issue opened, a comment on an issue, a
 * run of checks that failed, and a push to a branch.
 */
export const REPOSITORY_EVENTS = [
	"pull_request_opened",
	"pull_request_review",
	"pull_request_comment",
	"issue_opened",
	"issue_comment",
	"checks_failed",
	"push",
] as const;

export const repositoryEventSchema = Schema.Literals(REPOSITORY_EVENTS);

export type RepositoryEvent = typeof repositoryEventSchema.Type;

/**
 * Something that happened at one of a GitHub account's repositories, as an
 * automation's run is told of it: the fields of a GitHub run trigger besides
 * which connector and delivery it came from, and when.
 */
const repositoryActivitySchema = Schema.Struct({
	event: repositoryEventSchema,
	repository: Schema.String,
	/** Who did it, by their name at GitHub. */
	sender: Schema.String,
	/** Where to see it at GitHub. */
	url: Schema.String,
	/** The pull request or issue it is about, if any. */
	number: Schema.NullOr(Schema.Int),
	title: Schema.NullOr(Schema.String),
	/** What was written: a comment's or review's words, or a new issue's or pull request's description. */
	text: Schema.NullOr(Schema.String),
	/** The branch it is on, if any. */
	branch: Schema.NullOr(Schema.String),
	/** The comment it is about, if any. */
	comment: Schema.optional(
		Schema.NullOr(
			Schema.Struct({ id: Schema.Int, kind: Schema.Literals(["comment", "code_comment"]) }),
		),
	),
});

export type RepositoryActivity = typeof repositoryActivitySchema.Type;

/**
 * What a delivery to a GitHub app's webhook says happened: in which
 * workspace, under which id GitHub sends it again, and the activity, or
 * nothing for an event no automation is run by.
 */
export const deliveredActivitySchema = Schema.Struct({
	workspaceId: uuidSchema,
	deliveryId: Schema.UndefinedOr(Schema.String),
	activity: Schema.UndefinedOr(repositoryActivitySchema),
});

export type DeliveredActivity = typeof deliveredActivitySchema.Type;

/**
 * The repositories a GitHub connector's tools work on, the account they
 * belong to, and where its app is changed or deleted on GitHub.
 */
export const connectorRepositoriesSchema = Schema.Struct({
	/** Null until the connector's app is installed. */
	account: Schema.NullOr(Schema.String),
	repositories: Schema.Array(
		Schema.Struct({
			repository: repositoryPathSchema,
			/** Who added it; null once they've left. */
			addedByName: Schema.NullOr(Schema.String),
		}),
	),
});

export type ConnectorRepositories = typeof connectorRepositoriesSchema.Type;

/** A repository to add to or remove from a GitHub connector. */
export const connectorRepositoryChangeSchema = Schema.Struct({ repository: repositoryPathSchema });
