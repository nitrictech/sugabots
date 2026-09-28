import type { AgentUpdate, NewAgent } from "@sugabots/contracts";
import { Data, Effect } from "effect";
import type { ModelProviderStore } from "../../providers/model-providers/store.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import type { AgentStore } from "./store.ts";

export class AgentModelNotEnabled
	extends Data.TaggedError("AgentModelNotEnabled")<{ readonly model: string }>
	implements UserFacing
{
	override get message() {
		return `This workspace does not offer the model "${this.model}"`;
	}
	get userMessage() {
		return UserMessage.of`This workspace does not offer that model`;
	}
}

export class EmptyAgentUpdate extends Data.TaggedError("EmptyAgentUpdate") implements UserFacing {
	get userMessage() {
		return UserMessage.of`Nothing to change`;
	}
}

export class AgentNotFound extends Data.TaggedError("AgentNotFound") implements UserFacing {
	get userMessage() {
		return UserMessage.of`No such agent`;
	}
}

export function agentOperations(
	agents: AgentStore,
	modelProviders: Pick<ModelProviderStore, "isEnabled">,
) {
	const requireEnabledModel = (workspaceId: string, model: string) =>
		Effect.filterOrFail(
			modelProviders.isEnabled(workspaceId, model),
			(enabled) => enabled,
			() => new AgentModelNotEnabled({ model }),
		).pipe(Effect.asVoid);

	return {
		listVisible: (workspaceId: string, userId: string) => agents.listVisible(workspaceId, userId),

		create: (workspaceId: string, userId: string, input: NewAgent) =>
			Effect.andThen(requireEnabledModel(workspaceId, input.model), () =>
				agents.create(workspaceId, userId, input),
			),

		// A row that is not a crew agent is a system agent, which this API does
		// not describe: it belongs to the workspace and is read through its own.
		get: (row: Parameters<AgentStore["fromRow"]>[0]) =>
			Effect.filterOrFail(
				agents.fromRow(row),
				(found) => found !== undefined,
				() => new AgentNotFound(),
			),

		update: (workspaceId: string, agentId: string, input: AgentUpdate) =>
			Effect.gen(function* () {
				if (Object.keys(input).length === 0) {
					return yield* new EmptyAgentUpdate();
				}
				// Clearing the model names none to check the workspace can reach.
				if (input.model != null) {
					yield* requireEnabledModel(workspaceId, input.model);
				}
				return yield* agents.update(workspaceId, agentId, input);
			}),

		remove: (workspaceId: string, agentId: string) => agents.remove(workspaceId, agentId),
	};
}
