import { systemAgentKeySchema } from "@sugabots/contracts";
import { BadRequest, NotFound } from "@sugabots/contracts/http";
import type { ModelProviderStore } from "@sugabots/core/providers/model-providers/store";
import { AgentModelNotEnabled } from "@sugabots/core/workspaces/agents/operations";
import type { SystemAgentStore } from "@sugabots/core/workspaces/agents/system-agent-store";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

/**
 * The workspace's system agents, addressed by key. `SystemAgentsApi` says why
 * reading them is open to the whole workspace.
 */
export interface SystemAgentRoutesOptions {
	systemAgents: SystemAgentStore;
	modelProviders: Pick<ModelProviderStore, "isEnabled">;
}

export function systemAgentRoutes({ systemAgents, modelProviders }: SystemAgentRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "systemAgents", (handlers) =>
		handlers
			.handle("list", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) => systemAgents.list(workspaceId)),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const key = Schema.decodeUnknownOption(systemAgentKeySchema)(params.key);
					if (key._tag === "None") {
						return yield* new NotFound({ message: "No such built-in agent" });
					}
					const { workspaceId } = yield* grantedWorkspace;
					const { model } = payload;
					// Turning one off names no model, so there is nothing to check that
					// the workspace can reach. Choosing one is checked as a crew agent's
					// is: a model the workspace has not enabled is a bad request.
					const usableModel =
						model === null
							? Effect.void
							: Effect.filterOrFail(
									modelProviders.isEnabled(workspaceId, model),
									(enabled) => enabled,
									() => new AgentModelNotEnabled({ model }),
								).pipe(Effect.asVoid);
					return yield* usableModel.pipe(
						Effect.andThen(() => systemAgents.setModel(workspaceId, key.value, model)),
						asHttpError(systemAgentErrors),
					);
				}),
			),
	);
}

const systemAgentErrors = {
	AgentModelNotEnabled: BadRequest,
	SystemAgentMissing: NotFound,
};
