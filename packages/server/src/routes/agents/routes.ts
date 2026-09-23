import { agentUpdateSchema, newAgentInPodSchema } from "@sugabots/contracts";
import type { ModelProviderStore } from "@sugabots/core/providers/model-providers/store";
import type { Authorization } from "@sugabots/core/workspaces/access";
import {
	type AgentModelNotEnabled,
	type AgentNotFound,
	agentOperations,
	type EmptyAgentUpdate,
} from "@sugabots/core/workspaces/agents/operations";
import type {
	AgentStore,
	NameTaken,
	PodOutsideWorkspace,
	SystemAgentImmutable,
} from "@sugabots/core/workspaces/agents/store";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requireAgent, requirePod, requireWorkspace } from "../../http/authorisation.ts";
import { body } from "../../http/body.ts";
import { asHttpError, HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

export interface AgentRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	agents: AgentStore;
	modelProviders: Pick<ModelProviderStore, "isEnabled">;
}

export function createAgentRoutes({
	resolveSession,
	authorization,
	run,
	agents,
	modelProviders,
}: AgentRoutesOptions) {
	const session = requireSession(resolveSession);
	const inWorkspace = requireWorkspace(authorization, run, "workspace.read");
	const readsAgent = requireAgent(authorization, run, "agent.read");
	const updatesAgent = requireAgent(authorization, run, "agent.update");
	const deletesAgent = requireAgent(authorization, run, "agent.delete");
	const createsAgents = requirePod(authorization, run, "agent.create");
	const operations = agentOperations(agents, modelProviders);

	return new Hono<AuthEnv>()
		.get("/workspaces/:workspaceId/agents", session, inWorkspace, async (c) => {
			const { workspaceId, actor } = c.get("workspace");
			return c.json(await run(operations.listVisible(workspaceId, actor.userId)));
		})
		.post("/pods/:podId/agents", session, createsAgents, body(newAgentInPodSchema), async (c) => {
			const { pod } = c.get("pod");
			const created = await run(
				operations
					.create(pod.workspaceId, c.get("session").user.id, {
						...c.req.valid("json"),
						podId: pod.id,
					})
					.pipe(asHttpError(agentErrors)),
			);
			return c.json(created, 201);
		})
		.get("/agents/:agentId", session, readsAgent, async (c) =>
			c.json(await run(operations.get(c.get("agent").agent).pipe(asHttpError(agentErrors)))),
		)
		.patch("/agents/:agentId", session, updatesAgent, body(agentUpdateSchema), async (c) => {
			const { agent } = c.get("agent");
			const input = c.req.valid("json");
			return c.json(
				await run(
					operations.update(agent.workspaceId, agent.id, input).pipe(asHttpError(agentErrors)),
				),
			);
		})
		.delete("/agents/:agentId", session, deletesAgent, async (c) => {
			const { agent } = c.get("agent");
			await run(operations.remove(agent.workspaceId, agent.id).pipe(asHttpError(agentErrors)));
			return c.body(null, 204);
		});
}

const agentErrors = {
	AgentModelNotEnabled: (failure: AgentModelNotEnabled) =>
		new HttpError("bad_request", failure.message),
	EmptyAgentUpdate: (failure: EmptyAgentUpdate) => new HttpError("bad_request", failure.message),
	AgentNotFound: (failure: AgentNotFound) => new HttpError("not_found", failure.message),
	NameTaken: (failure: NameTaken) => new HttpError("conflict", failure.message),
	AgentGone: () => new HttpError("not_found", "No such agent"),
	SystemAgentImmutable: (failure: SystemAgentImmutable) =>
		new HttpError("bad_request", failure.message),
	PodOutsideWorkspace: (failure: PodOutsideWorkspace) =>
		new HttpError("bad_request", failure.message),
};
