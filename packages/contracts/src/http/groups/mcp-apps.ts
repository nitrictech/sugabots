import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	mcpAppResourceSchema,
	mcpAppToolCallSchema,
	mcpAppToolResultSchema,
} from "../../mcp-apps.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

export class McpAppsApi extends HttpApiGroup.make("mcpApps")
	.add(
		// Read from the call's connection each time, so a call in an old thread
		// shows the app as its server gives it now.
		HttpApiEndpoint.get("resource", "/tool-calls/:toolCallId/app", {
			params: { toolCallId: Schema.String },
			success: mcpAppResourceSchema,
			error: refused,
		}),
		// For a call still being written, whose row doesn't exist yet.
		HttpApiEndpoint.get("pendingResource", "/threads/:threadId/apps", {
			params: { threadId: Schema.String },
			query: { connectionId: Schema.String, resourceUri: Schema.String },
			success: mcpAppResourceSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("callTool", "/tool-calls/:toolCallId/app/calls", {
			params: { toolCallId: Schema.String },
			payload: mcpAppToolCallSchema,
			success: mcpAppToolResultSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}
