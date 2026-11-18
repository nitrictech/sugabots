import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const agentRoutes = HttpApiBuilder.group(ServerApi, "agents", (handlers) =>
	Effect.gen(function* () {
		const agents = yield* AgentAdministration.Service;
		return handlers
			.handle("list", ({ params }) =>
				agents.list({ workspace: params.workspace }).pipe(asSessionUser, asHttpError(agentErrors)),
			)
			.handle("create", ({ params, payload }) =>
				agents
					.create({ workspace: params.workspace, agent: payload })
					.pipe(asSessionUser, asHttpError(agentErrors)),
			)
			.handle("get", ({ params }) =>
				agents.get({ agentId: params.agentId }).pipe(asSessionUser, asHttpError(agentErrors)),
			)
			.handle("update", ({ params, payload }) =>
				agents
					.update({ agentId: params.agentId, changes: payload })
					.pipe(asSessionUser, asHttpError(agentErrors)),
			)
			.handle("remove", ({ params }) =>
				agents.remove({ agentId: params.agentId }).pipe(asSessionUser, asHttpError(agentErrors)),
			)
			.handle("pin", ({ params }) =>
				agents
					.setPinned({ agentId: params.agentId, pinned: true })
					.pipe(asSessionUser, asHttpError(agentErrors)),
			)
			.handle("unpin", ({ params }) =>
				agents
					.setPinned({ agentId: params.agentId, pinned: false })
					.pipe(asSessionUser, asHttpError(agentErrors)),
			)
			.handle("ensureAssistant", ({ params, payload }) =>
				agents
					.ensureAssistant({ workspace: params.workspace, model: payload.model })
					.pipe(asSessionUser, asHttpError(agentErrors)),
			);
	}),
);

const agentErrors = {
	...refusals,
	ModelNotEnabled: BadRequest,
	EmptyAgentUpdate: BadRequest,
	AgentNameTaken: Conflict,
	AgentHandleReserved: BadRequest,
	AgentGone: NotFound,
	SystemAgentImmutable: BadRequest,
	AssistantStaysPrivate: BadRequest,
	AssistantInstructionsManaged: BadRequest,
	AssistantManaged: BadRequest,
	SandboxUnavailable: Conflict,
};
