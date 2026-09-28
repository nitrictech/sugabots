import { systemAgentKeySchema } from "@sugabots/contracts";
import { BadRequest, NotFound } from "@sugabots/contracts/http";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/**
 * The workspace's system agents, addressed by key. `SystemAgentsApi` says why
 * reading them is open to the whole workspace.
 */
export const systemAgentRoutes = HttpApiBuilder.group(ServerApi, "systemAgents", (handlers) =>
	Effect.gen(function* () {
		const agents = yield* AgentAdministration.Service;
		return handlers
			.handle("list", ({ params }) =>
				agents
					.systemAgents({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(systemAgentErrors)),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const key = Schema.decodeUnknownOption(systemAgentKeySchema)(params.key);
					if (key._tag === "None") {
						return yield* new NotFound({ message: "No such built-in agent" });
					}
					return yield* agents
						.setSystemAgentModel({
							workspace: params.workspace,
							key: key.value,
							model: payload.model,
						})
						.pipe(asSessionUser, asHttpError(systemAgentErrors));
				}),
			);
	}),
);

const systemAgentErrors = {
	...refusals,
	ModelNotEnabled: BadRequest,
	SystemAgentMissing: NotFound,
};
