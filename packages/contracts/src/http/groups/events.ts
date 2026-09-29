import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { NotFound } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * Live updates as Server-Sent Events: one stream per open thread, one per
 * workspace, and one per person in a workspace for what only they are told. A client resumes with `Last-Event-ID` and misses nothing.
 *
 * The body is a stream, not a value, so the SDK reads it with its own event
 * source rather than through the generated client.
 */
const eventStream = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" }));

export class EventsApi extends HttpApiGroup.make("events")
	.add(
		HttpApiEndpoint.get("workspace", "/workspaces/:workspace/events", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: eventStream,
			error: NotFound,
		}),
		HttpApiEndpoint.get("member", "/workspaces/:workspace/me/events", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: eventStream,
			error: NotFound,
		}),
		HttpApiEndpoint.get("thread", "/threads/:threadId/events", {
			params: { threadId: Schema.String },
			success: eventStream,
			error: NotFound,
		}),
		/** Tells the thread's other watchers the caller is typing in it, as `person.typing`. */
		HttpApiEndpoint.post("typing", "/threads/:threadId/typing", {
			params: { threadId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: NotFound,
		}),
	)
	.middleware(Session) {}
