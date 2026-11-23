import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	accountRepositorySchema,
	connectorRepositoriesSchema,
	connectorRepositoryChangeSchema,
	GITHUB_APP_INSTALLED_PATH,
	GITHUB_APP_MADE_PATH,
	GITHUB_WEBHOOK_PATH,
	gitHubAppFormSchema,
	gitHubAppInstallSchema,
	newGitHubAppSchema,
} from "../../github.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, NotFound, refused, Unauthorized } from "../errors.ts";
import { Session } from "../middleware.ts";

const project = { projectId: uuidSchema };
const connected = { projectId: uuidSchema, connectorId: uuidSchema };

/**
 * A project's GitHub app, a bot's being its default project's: making it,
 * installing it on the account the project's bots work on, and the
 * repositories there they work on.
 */
export class GitHubConnectorsApi extends HttpApiGroup.make("gitHubConnectors")
	.add(
		HttpApiEndpoint.post("start", "/projects/:projectId/github", {
			params: project,
			payload: newGitHubAppSchema,
			success: gitHubAppFormSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.post(
			"installUrl",
			"/projects/:projectId/connectors/:connectorId/github/install",
			{
				params: connected,
				success: gitHubAppInstallSchema,
				error: [NotFound, ...refused],
			},
		),
		HttpApiEndpoint.get(
			"reachableRepositories",
			"/projects/:projectId/connectors/:connectorId/github/reachable",
			{
				params: connected,
				success: Schema.Array(accountRepositorySchema),
				error: [BadRequest, NotFound, ...refused],
			},
		),
		HttpApiEndpoint.get(
			"repositories",
			"/projects/:projectId/connectors/:connectorId/repositories",
			{
				params: connected,
				success: connectorRepositoriesSchema,
				error: [NotFound, ...refused],
			},
		),
		HttpApiEndpoint.post(
			"addRepository",
			"/projects/:projectId/connectors/:connectorId/repositories",
			{
				params: connected,
				payload: connectorRepositoryChangeSchema,
				success: connectorRepositoriesSchema,
				error: [BadRequest, NotFound, ...refused],
			},
		),
		// A repository's path has a slash in it, so it goes in the body.
		HttpApiEndpoint.post(
			"removeRepository",
			"/projects/:projectId/connectors/:connectorId/repositories/remove",
			{
				params: connected,
				payload: connectorRepositoryChangeSchema,
				success: connectorRepositoriesSchema,
				error: [NotFound, ...refused],
			},
		),
		// Where GitHub sends the browser back. Each answers with a redirect,
		// since a browser is reading it.
		HttpApiEndpoint.get("gitHubAppMade", GITHUB_APP_MADE_PATH, {
			query: { code: Schema.optional(Schema.String), state: Schema.optional(Schema.String) },
			success: HttpApiSchema.Empty(302),
		}),
		HttpApiEndpoint.get("gitHubAppInstalled", GITHUB_APP_INSTALLED_PATH, {
			query: {
				installation_id: Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
				state: Schema.optional(Schema.String),
			},
			success: HttpApiSchema.Empty(302),
		}),
	)
	.middleware(Session) {}

/**
 * Where a GitHub connector's app delivers events. Without a session: a
 * delivery is admitted by its signature under the app's webhook secret, over
 * the body exactly as sent.
 */
export class GitHubWebhooksApi extends HttpApiGroup.make("gitHubWebhooks").add(
	HttpApiEndpoint.post("delivery", `${GITHUB_WEBHOOK_PATH}/:connectorId`, {
		params: { connectorId: uuidSchema },
		payload: Schema.Json,
		success: HttpApiSchema.Empty(204),
		error: [BadRequest, Unauthorized],
	}),
) {}
