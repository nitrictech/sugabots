import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import type { ModelProviderStore } from "@sugabots/core/providers/model-providers/store";
import { agentOperations } from "@sugabots/core/workspaces/agents/operations";
import type { AgentStore } from "@sugabots/core/workspaces/agents/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedAgent, grantedPod, grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface AgentRoutesOptions {
	agents: AgentStore;
	modelProviders: Pick<ModelProviderStore, "isEnabled">;
}

export function agentRoutes({ agents, modelProviders }: AgentRoutesOptions) {
	const operations = agentOperations(agents, modelProviders);

	return HttpApiBuilder.group(ServerApi, "agents", (handlers) =>
		handlers
			.handle("list", () =>
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* grantedWorkspace;
					return yield* operations.listVisible(workspaceId, actor.userId);
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const { pod, actor } = yield* grantedPod;
					return yield* operations
						.create(pod.workspaceId, actor.userId, { ...payload, podId: pod.id })
						.pipe(asHttpError(agentErrors));
				}),
			)
			.handle("get", () =>
				Effect.flatMap(grantedAgent, ({ agent }) =>
					operations.get(agent).pipe(asHttpError(agentErrors)),
				),
			)
			.handle("update", ({ payload }) =>
				Effect.flatMap(grantedAgent, ({ agent }) =>
					operations.update(agent.workspaceId, agent.id, payload).pipe(asHttpError(agentErrors)),
				),
			)
			.handle("remove", () =>
				Effect.flatMap(grantedAgent, ({ agent }) =>
					operations.remove(agent.workspaceId, agent.id).pipe(asHttpError(agentErrors)),
				),
			),
	);
}

const agentErrors = {
	AgentModelNotEnabled: BadRequest,
	EmptyAgentUpdate: BadRequest,
	AgentNotFound: NotFound,
	NameTaken: Conflict,
	AgentGone: NotFound,
	SystemAgentImmutable: BadRequest,
	PodOutsideWorkspace: BadRequest,
};
