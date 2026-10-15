import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	GITHUB_APP_INSTALLED_PATH,
	GITHUB_APP_MADE_PATH,
	gitHubAppFormSchema,
	gitHubAppInstallSchema,
	newGitHubAppSchema,
} from "../../github.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, NotFound, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const pod = { podId: uuidSchema };
const connected = { podId: uuidSchema, connectionId: uuidSchema };

/**
 * A pod's GitHub connection: making its own GitHub App, and installing it on
 * the account the pod works on.
 */
export class GitHubConnectionsApi extends HttpApiGroup.make("gitHubConnections")
	.add(
		HttpApiEndpoint.post("start", "/pods/:podId/github", {
			params: pod,
			payload: newGitHubAppSchema,
			success: gitHubAppFormSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.post("installUrl", "/pods/:podId/connections/:connectionId/github/install", {
			params: connected,
			success: gitHubAppInstallSchema,
			error: [NotFound, ...refused],
		}),
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
