import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { agentSchema, agentUpdateSchema, newAgentInPodSchema } from "../../agents.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict } from "../errors.ts";
import { Access, Authorise, Session } from "../middleware.ts";

export class AgentsApi extends HttpApiGroup.make("agents")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspaceId/agents", {
			params: { workspaceId: uuidSchema },
			success: Schema.Array(agentSchema),
		}).annotate(Access, { workspace: "workspace.read" }),
		HttpApiEndpoint.post("create", "/pods/:podId/agents", {
			params: { podId: uuidSchema },
			payload: newAgentInPodSchema,
			success: agentSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict],
		}).annotate(Access, { pod: "agent.create" }),
		HttpApiEndpoint.get("get", "/agents/:agentId", {
			params: { agentId: uuidSchema },
			success: agentSchema,
		}).annotate(Access, { agent: "agent.read" }),
		HttpApiEndpoint.patch("update", "/agents/:agentId", {
			params: { agentId: uuidSchema },
			payload: agentUpdateSchema,
			success: agentSchema,
			error: [BadRequest, Conflict],
		}).annotate(Access, { agent: "agent.update" }),
		HttpApiEndpoint.delete("remove", "/agents/:agentId", {
			params: { agentId: uuidSchema },
		}).annotate(Access, { agent: "agent.delete" }),
	)
	.middleware(Authorise)
	.middleware(Session) {}
