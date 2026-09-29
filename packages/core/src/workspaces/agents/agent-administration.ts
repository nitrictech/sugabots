export * as AgentAdministration from "./agent-administration.ts";

import type {
	Agent,
	AgentUpdate,
	NewAgentInPod,
	SystemAgent,
	SystemAgentKey,
} from "@sugabots/contracts";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { serviceOperations, transaction } from "../../database/database.ts";
import { lockHeldModels } from "../../providers/model-providers/held-models.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { crewAgentRow, toAgent } from "./agent.ts";
import { systemAgents, visibleCrewAgents } from "./agent-reads.ts";
import { AgentRepository } from "./agent-repository.ts";

/**
 * A workspace's agents: the crew in its pods and the system agents it sets
 * up once. Whatever an agent runs on has to be a model the workspace offers.
 */
export interface Interface {
	/** The crew agents the current actor can see, by name. */
	readonly list: (input: {
		workspace: string;
	}) => Effect.Effect<Agent[], AuthorizationDenied, CurrentActor.Service>;
	readonly get: (input: {
		agentId: string;
	}) => Effect.Effect<Agent, AuthorizationDenied, CurrentActor.Service>;
	/** A crew agent in the pod, created by the actor. */
	readonly create: (input: {
		podId: string;
		agent: NewAgentInPod;
	}) => Effect.Effect<
		Agent,
		| AuthorizationDenied
		| ModelProviderRepository.ModelNotEnabled
		| AgentRepository.AgentNameTaken
		| AgentRepository.PodOutsideWorkspace,
		CurrentActor.Service
	>;
	readonly update: (input: {
		agentId: string;
		changes: AgentUpdate;
	}) => Effect.Effect<
		Agent,
		| AuthorizationDenied
		| EmptyAgentUpdate
		| ModelProviderRepository.ModelNotEnabled
		| AgentRepository.AgentNameTaken
		| AgentRepository.AgentGone
		| AgentRepository.SystemAgentImmutable,
		CurrentActor.Service
	>;
	readonly remove: (input: {
		agentId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | AgentRepository.SystemAgentImmutable,
		CurrentActor.Service
	>;
	readonly systemAgents: (input: {
		workspace: string;
	}) => Effect.Effect<SystemAgent[], AuthorizationDenied, CurrentActor.Service>;
	/** Points a system agent at a model the workspace offers. */
	readonly setSystemAgentModel: (input: {
		workspace: string;
		key: SystemAgentKey;
		model: string;
	}) => Effect.Effect<
		SystemAgent,
		| AuthorizationDenied
		| ModelProviderRepository.ModelNotEnabled
		| AgentRepository.SystemAgentMissing,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AgentAdministration",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AgentAdministration");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const agents = yield* AgentRepository.Service;
	const modelProviders = yield* ModelProviderRepository.Service;

	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(input.workspace, "workspace.read");
					return yield* visibleCrewAgents(workspaceId, yield* visibility.reachesPod);
				}),
			),

		get: ({ agentId }) =>
			operation(
				"get",
				Effect.gen(function* () {
					const standing = yield* authorization.agent(agentId, "agent.read");
					const crew = crewAgentRow(standing.agent);
					if (!crew) return yield* new ResourceHidden({ resource: "agent" });
					return toAgent(crew);
				}),
			),

		create: ({ podId, agent }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { pod, actor } = yield* authorization.pod(podId, "agent.create");
					yield* modelProviders.requireEnabled(pod.workspaceId, agent.model);
					return toAgent(
						yield* agents.create(pod.workspaceId, {
							createdById: actor.userId,
							agent: { ...agent, podId: pod.id },
						}),
					);
				}),
			),

		update: ({ agentId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const { agent } = yield* authorization.agent(agentId, "agent.update");
					if (Object.values(changes).every((value) => value === undefined)) {
						return yield* new EmptyAgentUpdate();
					}
					// A cleared model names none to check.
					if (changes.model != null) {
						yield* modelProviders.requireEnabled(agent.workspaceId, changes.model);
					}
					return toAgent(yield* agents.update(agent.workspaceId, agent.id, changes));
				}),
			),

		remove: ({ agentId }) =>
			operation(
				"remove",
				Effect.flatMap(authorization.agent(agentId, "agent.delete"), ({ agent }) =>
					agents.remove(agent.workspaceId, agent.id),
				),
			),

		systemAgents: (input) =>
			operation(
				"systemAgents",
				Effect.flatMap(
					authorization.workspace(input.workspace, "workspace.read"),
					({ workspaceId }) => systemAgents(workspaceId),
				),
			),

		setSystemAgentModel: ({ workspace, key, model }) =>
			operation(
				"setSystemAgentModel",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(
						workspace,
						"workspace.builtInAgents.configure",
					);
					// Held under the same lock as switching models off, so the model
					// cannot stop being offered between the check and the write.
					yield* transaction(
						Effect.gen(function* () {
							yield* lockHeldModels(workspaceId);
							yield* modelProviders.requireEnabled(workspaceId, model);
							yield* agents.setSystemAgentModel(workspaceId, key, model);
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
	Layer.provide([
		Authorization.layer,
		Visibility.layer,
		AgentRepository.layer,
		ModelProviderRepository.layer,
	]),
);

/** An agent update that names nothing to change. */
export class EmptyAgentUpdate extends Data.TaggedError("EmptyAgentUpdate") implements UserFacing {
	get userMessage() {
		return UserMessage.of`Nothing to change`;
	}
}
