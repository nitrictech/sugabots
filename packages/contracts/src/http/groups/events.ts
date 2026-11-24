import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { NotFound } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * Live updates as Server-Sent Events: one stream per open chat, one per
 * workspace, and one for the current user. A client resumes with
 * `Last-Event-ID` and misses nothing.
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
		HttpApiEndpoint.get("chat", "/chats/:chatId/events", {
			params: { chatId: Schema.String },
			success: eventStream,
			error: NotFound,
		}),
		/** What is for the current user alone, such as their notifications. */
		HttpApiEndpoint.get("me", "/me/events", { success: eventStream, error: NotFound }),
		/** Tells the chat's other watchers the caller is typing in it, as `member.typing`. */
		HttpApiEndpoint.post("typing", "/chats/:chatId/typing", {
			params: { chatId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: NotFound,
		}),
	)
	.middleware(Session) {}
