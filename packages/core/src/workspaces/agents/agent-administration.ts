export * as AgentAdministration from "./agent-administration.ts";

import type {
	Agent,
	AgentUpdate,
	NewAgent,
	SystemAgent,
	SystemAgentKey,
} from "@sugabots/contracts";
import { Context, Data, Effect, Layer } from "effect";
import { serviceOperations, transaction } from "../../database/database.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { PodRepository } from "../pods/pod-repository.ts";
import { toAgent } from "./agent.ts";
import { systemAgents, visibleCrewAgents } from "./agent-reads.ts";
import { AgentRepository } from "./agent-repository.ts";
import { FACILITATE_SYSTEM_AGENT } from "./system-agents.ts";

/**
 * A workspace's agents: the crew in its pods and the system agents it sets
 * up once. Whatever an agent runs on has to be a model the workspace offers.
 */
export interface Interface {
	/** The crew agents `userId` can see, by name. */
	readonly list: (input: { workspaceId: string; userId: string }) => Effect.Effect<Agent[]>;
	readonly create: (input: {
		workspaceId: string;
		createdById: string;
		agent: NewAgent;
	}) => Effect.Effect<
		Agent,
		| ModelProviderRepository.ModelNotEnabled
		| AgentRepository.AgentNameTaken
		| AgentRepository.PodOutsideWorkspace
	>;
	readonly update: (input: {
		workspaceId: string;
		agentId: string;
		changes: AgentUpdate;
	}) => Effect.Effect<
		Agent,
		| EmptyAgentUpdate
		| ModelProviderRepository.ModelNotEnabled
		| AgentRepository.AgentNameTaken
		| AgentRepository.AgentGone
		| AgentRepository.SystemAgentImmutable
	>;
	readonly remove: (input: {
		workspaceId: string;
		agentId: string;
	}) => Effect.Effect<void, AgentRepository.SystemAgentImmutable>;
	readonly systemAgents: (workspaceId: string) => Effect.Effect<SystemAgent[]>;
	/**
	 * Points a system agent at a model, which is how it is set up, or at `null`,
	 * which turns it off.
	 *
	 * Turning the Facilitator off also stops every pod routing through it, in
	 * the same transaction: a pod pointed at an agent that cannot run would say
	 * one thing and do another.
	 */
	readonly setSystemAgentModel: (input: {
		workspaceId: string;
		key: SystemAgentKey;
		model: string | null;
	}) => Effect.Effect<
		SystemAgent,
		ModelProviderRepository.ModelNotEnabled | AgentRepository.SystemAgentMissing
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AgentAdministration",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AgentAdministration");
	const agents = yield* AgentRepository.Service;
	const pods = yield* PodRepository.Service;
	const modelProviders = yield* ModelProviderRepository.Service;

	return Service.of({
		list: ({ workspaceId, userId }) => operation("list", visibleCrewAgents(workspaceId, userId)),

		create: ({ workspaceId, createdById, agent }) =>
			operation(
				"create",
				Effect.gen(function* () {
					yield* modelProviders.requireEnabled(workspaceId, agent.model);
					return toAgent(yield* agents.create(workspaceId, { createdById, agent }));
				}),
			),

		update: ({ workspaceId, agentId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					if (Object.values(changes).every((value) => value === undefined)) {
						return yield* new EmptyAgentUpdate();
					}
					// A cleared model names none to check.
					if (changes.model != null) {
						yield* modelProviders.requireEnabled(workspaceId, changes.model);
					}
					return toAgent(yield* agents.update(workspaceId, agentId, changes));
				}),
			),

		remove: ({ workspaceId, agentId }) => operation("remove", agents.remove(workspaceId, agentId)),

		systemAgents: (workspaceId) => operation("systemAgents", systemAgents(workspaceId)),

		setSystemAgentModel: ({ workspaceId, key, model }) =>
			operation(
				"setSystemAgentModel",
				Effect.gen(function* () {
					if (model !== null) {
						yield* modelProviders.requireEnabled(workspaceId, model);
					}
					yield* transaction(
						Effect.gen(function* () {
							yield* agents.setSystemAgentModel(workspaceId, key, model);
							if (key === FACILITATE_SYSTEM_AGENT && model === null) {
								yield* pods.stopFacilitatorRouting(workspaceId);
							}
						}),
					);
					const updated = (yield* systemAgents(workspaceId)).find(
						(candidate) => candidate.key === key,
					);
					if (!updated) {
						return yield* new AgentRepository.SystemAgentMissing({ key });
					}
					return updated;
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([AgentRepository.layer, PodRepository.layer, ModelProviderRepository.layer]),
);

/** An agent update that names nothing to change. */
export class EmptyAgentUpdate extends Data.TaggedError("EmptyAgentUpdate") implements UserFacing {
	get userMessage() {
		return UserMessage.of`Nothing to change`;
	}
}
