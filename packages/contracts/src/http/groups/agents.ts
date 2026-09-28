import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { agentSchema, agentUpdateSchema, newAgentInPodSchema } from "../../agents.ts";
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
		HttpApiEndpoint.post("create", "/pods/:podId/agents", {
			params: { podId: uuidSchema },
			payload: newAgentInPodSchema,
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
			error: refused,
		}),
	)
	.middleware(Session) {}
