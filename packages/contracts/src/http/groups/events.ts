import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { Authorise, Session } from "../middleware.ts";

/**
 * Live updates as Server-Sent Events: one stream per open thread, one per
 * workspace. A client resumes with `Last-Event-ID` and misses nothing.
 *
 * The body is a stream, not a value, so the SDK reads it with its own event
 * source rather than through the generated client.
 */
const eventStream = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" }));

export class EventsApi extends HttpApiGroup.make("events")
	.add(
		HttpApiEndpoint.get("workspace", "/workspaces/:workspaceId/events", {
			params: { workspaceId: Schema.String },
			success: eventStream,
		}),
		HttpApiEndpoint.get("thread", "/threads/:threadId/events", {
			params: { threadId: Schema.String },
			success: eventStream,
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
