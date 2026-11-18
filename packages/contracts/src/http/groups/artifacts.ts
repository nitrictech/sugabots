import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	artifactSchema,
	artifactSummarySchema,
	artifactVersionSummarySchema,
} from "../../artifacts.ts";
import { uuidSchema } from "../../uuid.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/artifacts";
const artifact = { artifactId: uuidSchema };
const version = {
	...artifact,
	version: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
};

export class ArtifactsApi extends HttpApiGroup.make("artifacts")
	.add(
		/** The files bots made in the channel's conversations. */
		HttpApiEndpoint.get("listInPod", "/pods/:podId/artifacts", {
			params: { podId: uuidSchema },
			success: Schema.Array(artifactSummarySchema),
			error: refused,
		}),
		/** The files the bot made in its tasks. */
		HttpApiEndpoint.get("listForAgent", "/agents/:agentId/artifacts", {
			params: { agentId: uuidSchema },
			success: Schema.Array(artifactSummarySchema),
			error: refused,
		}),
		HttpApiEndpoint.get("get", `${root}/:artifactId`, {
			params: artifact,
			success: artifactSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("versions", `${root}/:artifactId/versions`, {
			params: artifact,
			success: Schema.Array(artifactVersionSummarySchema),
			error: refused,
		}),
		HttpApiEndpoint.get("getVersion", `${root}/:artifactId/versions/:version`, {
			params: version,
			success: artifactSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("pageAddress", `${root}/:artifactId/versions/:version/page`, {
			params: version,
			success: Schema.Struct({
				/** Where the page loads from on the content origin, for a few minutes; `null` when no content origin is set. */
				url: Schema.NullOr(Schema.String),
			}),
			error: refused,
		}),
		HttpApiEndpoint.delete("remove", `${root}/:artifactId`, {
			params: artifact,
			error: refused,
		}),
	)
	.middleware(Session) {}
