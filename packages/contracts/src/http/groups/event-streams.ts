import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { uuidOrStringSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { NotFound, Unauthorized } from "../errors.ts";
import { Session } from "../middleware.ts";
import { Entrypoint } from "../served.ts";

/**
 * The event stream entrypoint: live updates as Server-Sent Events, one stream
 * per open chat, one per workspace, and one for the current user. A client resumes with
 * `Last-Event-ID` and misses nothing.
 *
 * The body is a stream, not a value, so the SDK reads it with its own event
 * source rather than through the generated client. A stream reads its
 * session afresh as it opens, so one revoked since its cookie was cached is
 * refused as `Unauthorized`; it ends when its session ends or expires, or the
 * member stops reaching what it follows, and the client reconnects.
 */
const eventStream = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" }));

export class EventStreamsApi extends HttpApiGroup.make("eventStreams")
	.add(
		HttpApiEndpoint.get("workspace", "/workspaces/:workspace/events", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: eventStream,
			error: [NotFound, Unauthorized],
		}),
		HttpApiEndpoint.get("chat", "/chats/:chatId/events", {
			params: { chatId: uuidOrStringSchema },
			success: eventStream,
			error: [NotFound, Unauthorized],
		}),
		/** What is for the current user alone, such as their notifications. */
		HttpApiEndpoint.get("me", "/me/events", { success: eventStream, error: Unauthorized }),
	)
	.middleware(Session)
	.annotate(
		Entrypoint,
		"The event stream: each stream follows its long-running operation, held back from the HTTP API.",
	) {}
