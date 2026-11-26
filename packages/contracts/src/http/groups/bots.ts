import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { botSchema, botUpdateSchema, newBotSchema } from "../../bots.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

export class BotsApi extends HttpApiGroup.make("bots")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/bots", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(botSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("create", "/workspaces/:workspace/bots", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: newBotSchema,
			success: botSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.patch("update", "/bots/:botId", {
			params: { botId: uuidSchema },
			payload: botUpdateSchema,
			success: botSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("remove", "/bots/:botId", {
			params: { botId: uuidSchema },
			error: [Conflict, ...refused],
		}),
		/** Pins the bot to the caller's sidebar. */
		HttpApiEndpoint.put("pin", "/bots/:botId/pin", {
			params: { botId: uuidSchema },
			success: botSchema,
			error: refused,
		}),
		HttpApiEndpoint.delete("unpin", "/bots/:botId/pin", {
			params: { botId: uuidSchema },
			success: botSchema,
			error: refused,
		}),
		/** A Personal Assistant for the caller, besides any they have. */
		HttpApiEndpoint.post("createAssistant", "/workspaces/:workspace/assistants", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: botSchema.pipe(HttpApiSchema.status(201)),
			error: refused,
		}),
	)
	.middleware(Session) {}
