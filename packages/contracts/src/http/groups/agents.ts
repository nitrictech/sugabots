import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { agentSchema, agentUpdateSchema, newAgentInPodSchema } from "../../agents.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

export class AgentsApi extends HttpApiGroup.make("agents")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspaceId/agents", {
			params: { workspaceId: uuidSchema },
			success: Schema.Array(agentSchema),
		}),
		HttpApiEndpoint.post("create", "/pods/:podId/agents", {
			params: { podId: uuidSchema },
			payload: newAgentInPodSchema,
			success: agentSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.get("get", "/agents/:agentId", {
			params: { agentId: uuidSchema },
			success: agentSchema,
		}),
		HttpApiEndpoint.patch("update", "/agents/:agentId", {
			params: { agentId: uuidSchema },
			payload: agentUpdateSchema,
			success: agentSchema,
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.delete("remove", "/agents/:agentId", {
			params: { agentId: uuidSchema },
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
