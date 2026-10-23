export * as AgentAdministration from "./agent-administration.ts";

import type {
	A2ACard,
	A2AEndpointInput,
	Agent,
	AgentUpdate,
	NewAgentInPod,
	SystemAgent,
	SystemAgentKey,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { Credentials } from "../../credentials/credentials.ts";
import { serviceOperations } from "../../database/database.ts";
import { Devices } from "../../devices/devices.ts";
import { A2A } from "../../providers/a2a/a2a.ts";
import { holdingModel } from "../../providers/model-providers/held-models.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { Egress } from "../../providers/network/egress.ts";
import type { UserFacing } from "../../user-message.ts";
import { crewAgentRow, type SealedA2AEndpoint, toAgent } from "./agent.ts";
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
		| AgentNeedsModel
		| Egress.EgressRefused
		| Devices.DeviceNotFound
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
		| Egress.EgressRefused
		| Devices.DeviceNotFound
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
	/** What the agent at an A2A address says it is, for somebody who may add a bot to the pod. */
	readonly readA2ACard: (input: {
		podId: string;
		endpoint: A2AEndpointInput;
	}) => Effect.Effect<
		A2ACard,
		AuthorizationDenied | Egress.EgressRefused | Devices.DeviceNotFound | A2ACardUnreadable,
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
	const credentials = yield* Credentials.Service;
	const egress = yield* Egress.Service;
	const a2a = yield* A2A.Service;
	const devices = yield* Devices.Service;

	/**
	 * Fails unless the actor may send the agent's requests where `endpoint`
	 * says: through the egress policy, or through a device of their own.
	 */
	const checkReach = (endpoint: A2AEndpointInput) =>
		endpoint.deviceId === undefined
			? egress.validateProviderUrl(endpoint.url)
			: Effect.asVoid(devices.owned(endpoint.deviceId));

	/**
	 * The endpoint checked with {@link checkReach}, with its secret sealed.
	 * An update that leaves the secret out keeps the one stored, while the
	 * header it is sent in stays the same.
	 */
	const sealA2A = (input: A2AEndpointInput, stored?: SealedA2AEndpoint) =>
		Effect.gen(function* () {
			yield* checkReach(input);
			const secretHeader = input.secretHeader ?? null;
			const keptSecret =
				input.secret === undefined && stored?.a2aSecretHeader === secretHeader
					? stored.a2aSecretEncrypted
					: null;
			return {
				a2aUrl: input.url,
				a2aDeviceId: input.deviceId ?? null,
				a2aSecretHeader: secretHeader,
				a2aSecretEncrypted:
					input.secret === undefined
						? keptSecret
						: credentials.encrypt(input.secret, A2A.SECRET_PURPOSE),
			} satisfies SealedA2AEndpoint;
		});

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
					if (agent.usesSandbox) yield* authorization.pod(podId, "sandbox.manage");
					if (agent.model !== undefined) {
						yield* modelProviders.requireEnabled(pod.workspaceId, agent.model);
					} else if (agent.a2a === undefined) {
						return yield* new AgentNeedsModel();
					}
					const a2a = agent.a2a && (yield* sealA2A(agent.a2a));
					return toAgent(
						yield* agents.create(pod.workspaceId, {
							createdById: actor.userId,
							agent: { ...agent, podId: pod.id, a2a },
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
					if (changes.usesSandbox !== undefined && changes.usesSandbox !== agent.usesSandbox) {
						yield* authorization.agent(agentId, "sandbox.manage");
					}
					// A cleared model names none to check.
					if (changes.model != null) {
						yield* modelProviders.requireEnabled(agent.workspaceId, changes.model);
					}
					const a2a = changes.a2a && (yield* sealA2A(changes.a2a, sealedEndpointOf(agent)));
					return toAgent(
						yield* agents.update(agent.workspaceId, agent.id, {
							...changes,
							a2a: changes.a2a === null ? null : a2a,
						}),
					);
				}),
			),

		remove: ({ agentId }) =>
			operation(
				"remove",
				Effect.flatMap(authorization.agent(agentId, "agent.delete"), ({ agent }) =>
					agents.remove(agent.workspaceId, agent.id),
				),
			),

		readA2ACard: ({ podId, endpoint }) =>
			operation(
				"readA2ACard",
				Effect.gen(function* () {
					yield* authorization.pod(podId, "agent.create");
					yield* checkReach(endpoint);
					return yield* a2a
						.readCard(endpoint)
						.pipe(Effect.mapError((failure) => new A2ACardUnreadable({ reason: failure.reason })));
				}),
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
					yield* holdingModel(
						workspaceId,
						model,
						agents.setSystemAgentModel(workspaceId, key, model),
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
		A2A.layer,
		Devices.layer,
	]),
);

/** No A2A agent card could be read at the address given, with the secret given. */
export class A2ACardUnreadable
	extends Data.TaggedError("A2ACardUnreadable")<{ readonly reason: string }>
	implements UserFacing
{
	override get message() {
		return `Reading an A2A agent card failed: ${this.reason}`;
	}
	get userMessage() {
		return userText`No agent card could be read at that address. Check it, and the secret if its service needs one.`;
	}
}

/** An agent created with neither a model to run on nor an A2A agent to reach. */
export class AgentNeedsModel extends Data.TaggedError("AgentNeedsModel") implements UserFacing {
	get userMessage() {
		return userText`Choose a model for the bot, or the external agent it stands for`;
	}
}

function sealedEndpointOf(row: {
	a2aUrl: string | null;
	a2aDeviceId: string | null;
	a2aSecretHeader: string | null;
	a2aSecretEncrypted: string | null;
}): SealedA2AEndpoint | undefined {
	return row.a2aUrl === null ? undefined : { ...row, a2aUrl: row.a2aUrl };
}

/** An agent update that names nothing to change. */
export class EmptyAgentUpdate extends Data.TaggedError("EmptyAgentUpdate") implements UserFacing {
	get userMessage() {
		return userText`Nothing to change`;
	}
}
