import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { crewAgentRow, toAgent } from "@sugabots/core/workspaces/agents/agent";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedAgent, grantedPod, grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export const agentRoutes = HttpApiBuilder.group(ServerApi, "agents", (handlers) =>
	Effect.gen(function* () {
		const agents = yield* AgentAdministration.Service;
		return handlers
			.handle("list", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					agents.list({ workspaceId, userId: actor.userId }),
				),
			)
			.handle("create", ({ payload }) =>
				Effect.flatMap(grantedPod, ({ pod, actor }) =>
					agents
						.create({
							workspaceId: pod.workspaceId,
							createdById: actor.userId,
							agent: { ...payload, podId: pod.id },
						})
						.pipe(asHttpError(agentErrors)),
				),
			)
			.handle("get", () =>
				Effect.flatMap(grantedAgent, ({ agent }) => {
					// A system agent belongs to the workspace and is read through the
					// system agents' own endpoints, not this one.
					const crew = crewAgentRow(agent);
					return crew
						? Effect.succeed(toAgent(crew))
						: Effect.fail(new NotFound({ message: "No such agent" }));
				}),
			)
			.handle("update", ({ payload }) =>
				Effect.flatMap(grantedAgent, ({ agent }) =>
					agents
						.update({ workspaceId: agent.workspaceId, agentId: agent.id, changes: payload })
						.pipe(asHttpError(agentErrors)),
				),
			)
			.handle("remove", () =>
				Effect.flatMap(grantedAgent, ({ agent }) =>
					agents
						.remove({ workspaceId: agent.workspaceId, agentId: agent.id })
						.pipe(asHttpError(agentErrors)),
				),
			);
	}),
);

const agentErrors = {
	ModelNotEnabled: BadRequest,
	EmptyAgentUpdate: BadRequest,
	AgentNameTaken: Conflict,
	AgentGone: NotFound,
	SystemAgentImmutable: BadRequest,
	PodOutsideWorkspace: BadRequest,
};
