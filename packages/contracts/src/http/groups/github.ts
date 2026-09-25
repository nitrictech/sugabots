import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	githubAppManifestSchema,
	githubAppStartSchema,
	githubConnectionResponseSchema,
	githubConnectionSchema,
	githubConnectionTestResultSchema,
	githubConnectionUpdateSchema,
	newGithubConnectionSchema,
	newPodRepositorySchema,
	podRepositorySchema,
} from "../../github.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

/** A workspace has at most one GitHub connection, so it is addressed by the workspace alone. */
const root = "/workspaces/:workspace/github";
const params = { workspace: workspaceIdOrSlugSchema };

export class GithubApi extends HttpApiGroup.make("github")
	.add(
		HttpApiEndpoint.get("get", root, { params, success: githubConnectionResponseSchema }),
		HttpApiEndpoint.put("replace", root, {
			params,
			payload: newGithubConnectionSchema,
			success: githubConnectionSchema.pipe(HttpApiSchema.status(201)),
			error: BadRequest,
		}),
		HttpApiEndpoint.patch("update", root, {
			params,
			payload: githubConnectionUpdateSchema,
			success: githubConnectionSchema,
			error: BadRequest,
		}),
		HttpApiEndpoint.delete("remove", root, { params }),
		HttpApiEndpoint.post("test", `${root}/test`, {
			params,
			success: githubConnectionTestResultSchema,
		}),
		HttpApiEndpoint.post("startApp", `${root}/app`, {
			params,
			payload: githubAppStartSchema,
			success: githubAppManifestSchema,
			error: BadRequest,
		}),
		// Where GitHub sends the browser once the app is registered, and then
		// once it is installed. Both redirect to the web app's GitHub settings.
		HttpApiEndpoint.get("appCreated", "/github/app/created", {
			query: { code: Schema.optional(Schema.String), state: Schema.optional(Schema.String) },
			success: HttpApiSchema.Empty(302),
		}),
		HttpApiEndpoint.get("appInstalled", "/github/app/installed", {
			query: {
				installation_id: Schema.optional(Schema.String),
				setup_action: Schema.optional(Schema.String),
				state: Schema.optional(Schema.String),
			},
			success: HttpApiSchema.Empty(302),
		}),
		HttpApiEndpoint.get("listPodRepositories", "/pods/:podId/repositories", {
			params: { podId: uuidSchema },
			success: Schema.Array(podRepositorySchema),
		}),
		HttpApiEndpoint.post("addPodRepository", "/pods/:podId/repositories", {
			params: { podId: uuidSchema },
			payload: newPodRepositorySchema,
			success: podRepositorySchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.delete("removePodRepository", "/pods/:podId/repositories/:repositoryId", {
			params: { podId: uuidSchema, repositoryId: uuidSchema },
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
