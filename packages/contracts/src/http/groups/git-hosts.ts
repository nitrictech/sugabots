import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	availableRepositoriesSchema,
	GITHUB_APP_INSTALLED_PATH,
	GITHUB_APP_MADE_PATH,
	gitHostSchema,
	gitHubAppFormSchema,
	gitHubAppInstallSchema,
	newGitHubAppSchema,
	podRepositoriesSchema,
	podRepositorySchema,
} from "../../git-hosts.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, NotFound, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/workspaces/:workspace/git-hosts";
const workspace = { workspace: workspaceIdOrSlugSchema };
const host = { workspace: workspaceIdOrSlugSchema, gitHostId: uuidSchema };
const repositories = "/pods/:podId/repositories";
const pod = { podId: uuidSchema };

/**
 * Where a workspace keeps code: making and installing its GitHub App, and the
 * repositories each pod's agents work on.
 */
export class GitHostsApi extends HttpApiGroup.make("gitHosts")
	.add(
		HttpApiEndpoint.get("list", root, {
			params: workspace,
			success: Schema.Array(gitHostSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("startGitHubApp", `${root}/github`, {
			params: workspace,
			payload: newGitHubAppSchema,
			success: gitHubAppFormSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.post("installUrl", `${root}/:gitHostId/install`, {
			params: host,
			success: gitHubAppInstallSchema,
			error: [NotFound, ...refused],
		}),
		HttpApiEndpoint.delete("remove", `${root}/:gitHostId`, { params: host, error: refused }),
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
		HttpApiEndpoint.get("podRepositories", repositories, {
			params: pod,
			success: podRepositoriesSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("availableRepositories", `${repositories}/available`, {
			params: pod,
			success: availableRepositoriesSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.post("addRepository", repositories, {
			params: pod,
			payload: podRepositorySchema,
			success: podRepositoriesSchema,
			error: [BadRequest, ...refused],
		}),
		// A repository's name has a slash in it, so it goes in the body.
		HttpApiEndpoint.post("removeRepository", `${repositories}/remove`, {
			params: pod,
			payload: podRepositorySchema,
			success: podRepositoriesSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}
