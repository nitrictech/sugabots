import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { agentSchema, agentUpdateSchema, modelIdSchema, newAgentSchema } from "../../agents.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

export class AgentsApi extends HttpApiGroup.make("agents")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/agents", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(agentSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("create", "/workspaces/:workspace/agents", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: newAgentSchema,
			success: agentSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.get("get", "/agents/:agentId", {
			params: { agentId: uuidSchema },
			success: agentSchema,
			error: refused,
		}),
		HttpApiEndpoint.patch("update", "/agents/:agentId", {
			params: { agentId: uuidSchema },
			payload: agentUpdateSchema,
			success: agentSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("remove", "/agents/:agentId", {
			params: { agentId: uuidSchema },
			error: [Conflict, ...refused],
		}),
		/** Pins the bot to the caller's sidebar. */
		HttpApiEndpoint.put("pin", "/agents/:agentId/pin", {
			params: { agentId: uuidSchema },
			success: agentSchema,
			error: refused,
		}),
		HttpApiEndpoint.delete("unpin", "/agents/:agentId/pin", {
			params: { agentId: uuidSchema },
			success: agentSchema,
			error: refused,
		}),
		/** The caller's Personal Assistant, made on `model` when they have none yet. */
		HttpApiEndpoint.post("ensureAssistant", "/workspaces/:workspace/assistant", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: Schema.Struct({ model: Schema.optional(modelIdSchema) }),
			success: agentSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}
