import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { threadDetailsSchema, threadHistoryQuerySchema, threadSchema } from "../../threads.ts";
import { uuidSchema } from "../../uuid.ts";
import { Authorise, Session } from "../middleware.ts";

export class ThreadsApi extends HttpApiGroup.make("threads")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspaceId/threads", {
			params: { workspaceId: uuidSchema },
			success: Schema.Array(threadSchema),
		}),
		// HEAD answers the same with a one-message page, for asking whether the
		// thread is there without its history.
		HttpApiEndpoint.get("get", "/threads/:threadId", {
			params: { threadId: Schema.String },
			query: threadHistoryQuerySchema,
			success: threadDetailsSchema,
		}),
		HttpApiEndpoint.post("cancelTurn", "/turns/:turnId/cancel", {
			params: { turnId: Schema.String },
			success: HttpApiSchema.Empty(202),
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
