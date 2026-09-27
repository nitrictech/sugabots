import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	threadActivitySchema,
	threadDetailsSchema,
	threadHistoryQuerySchema,
	threadSchema,
} from "../../threads.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { Authorise, Session } from "../middleware.ts";

export class ThreadsApi extends HttpApiGroup.make("threads")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/threads", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(threadSchema),
		}),
		// HEAD answers the same with a one-message page, for asking whether the
		// thread is there without its history.
		HttpApiEndpoint.get("get", "/threads/:threadId", {
			params: { threadId: Schema.String },
			query: threadHistoryQuerySchema,
			success: threadDetailsSchema,
		}),
		HttpApiEndpoint.get("activity", "/threads/:threadId/activity", {
			params: { threadId: Schema.String },
			success: threadActivitySchema,
		}),
		HttpApiEndpoint.post("cancelTurn", "/turns/:turnId/cancel", {
			params: { turnId: Schema.String },
			success: HttpApiSchema.Empty(202),
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
