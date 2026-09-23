import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { threadDetailsSchema, threadHistoryQuerySchema, threadSchema } from "../../threads.ts";
import { uuidSchema } from "../../uuid.ts";
import { Access, Authorise, Session } from "../middleware.ts";

export class ThreadsApi extends HttpApiGroup.make("threads")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspaceId/threads", {
			params: { workspaceId: uuidSchema },
			success: Schema.Array(threadSchema),
		}).annotate(Access, { workspace: "workspace.read" }),
		// HEAD answers the same with a one-message page, for asking whether the
		// thread is there without its history.
		HttpApiEndpoint.get("get", "/threads/:threadId", {
			params: { threadId: Schema.String },
			query: threadHistoryQuerySchema,
			success: threadDetailsSchema,
		}).annotate(Access, { reach: "threads/store.ts scopes by visibleThread" }),
		HttpApiEndpoint.post("cancelTurn", "/turns/:turnId/cancel", {
			params: { turnId: Schema.String },
			success: HttpApiSchema.Empty(202),
		}).annotate(Access, { reach: "turns/store.ts scopes by visibleThread" }),
	)
	.middleware(Authorise)
	.middleware(Session) {}
