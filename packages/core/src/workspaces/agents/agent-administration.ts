export * as AgentAdministration from "./agent-administration.ts";

import type {
	Agent,
	AgentUpdate,
	NewAgent,
	SystemAgent,
	SystemAgentKey,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import type { Actor } from "../../authorization/permissions.ts";
import { serviceOperations } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { holdingModel } from "../../providers/model-providers/held-models.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { AgentSandboxes } from "../../sandboxes/agent-sandboxes.ts";
import type { Sandboxes } from "../../sandboxes/sandboxes.ts";
import type { UserFacing } from "../../user-message.ts";
import { crewAgentRow, toAgent } from "./agent.ts";
import { systemAgents, visibleCrewAgents } from "./agent-reads.ts";
import { AgentRepository } from "./agent-repository.ts";

/**
 * A workspace's bots: those people make, each person's Personal Assistant,
 * and the system bots it sets up once. Whatever a bot runs on has to be a
 * model the workspace offers.
 */
export interface Interface {
	/** The bots the current actor sees, by name: those they reach, and every private one for an admin. */
	readonly list: (input: {
		workspace: string;
	}) => Effect.Effect<Agent[], AuthorizationDenied, CurrentActor.Service>;
	readonly get: (input: {
		agentId: string;
	}) => Effect.Effect<Agent, AuthorizationDenied, CurrentActor.Service>;
	/** A bot made by the actor, and pinned for them. */
	readonly create: (input: {
		workspace: string;
		agent: NewAgent;
	}) => Effect.Effect<
		Agent,
		| AuthorizationDenied
		| ModelProviderRepository.ModelNotEnabled
		| AgentRepository.AgentNameTaken
		| AgentRepository.AgentHandleReserved,
		CurrentActor.Service
	>;
	/** Pins the bot to the actor's sidebar, or takes it off. */
	readonly setPinned: (input: {
		agentId: string;
		pinned: boolean;
	}) => Effect.Effect<Agent, AuthorizationDenied, CurrentActor.Service>;
	/** The actor's Personal Assistant, made on `model` when they have none. */
	readonly ensureAssistant: (input: {
		workspace: string;
		model?: string;
	}) => Effect.Effect<
		Agent,
		AuthorizationDenied | ModelProviderRepository.ModelNotEnabled,
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
		| AgentRepository.AgentHandleReserved
		| AgentRepository.AgentGone
		| AgentRepository.SystemAgentImmutable
		| AssistantStaysPrivate
		| AssistantInstructionsManaged
		| AssistantManaged,
		CurrentActor.Service
	>;
	readonly remove: (input: {
		agentId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | AgentRepository.SystemAgentImmutable | Sandboxes.Unavailable,
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
	const agents = yield* AgentRepository.Service;
	const modelProviders = yield* ModelProviderRepository.Service;
	const agentSandboxes = yield* AgentSandboxes.Service;

	/** The bot as `actor` is shown it, with whether they pinned it. */
	const shown = (row: schema.AgentRow, actor: Actor) =>
		Effect.gen(function* () {
			const crew = crewAgentRow(row);
			if (!crew) return yield* new ResourceHidden({ resource: "agent" });
			return toAgent(crew, { actor, pinned: yield* agents.isPinned(actor.userId, row.id) });
		});

	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						input.workspace,
						"workspace.read",
					);
					return yield* visibleCrewAgents(workspaceId, actor);
				}),
			),

		get: ({ agentId }) =>
			operation(
				"get",
				Effect.gen(function* () {
					const standing = yield* authorization.agent(agentId, "agent.settings.read");
					return yield* shown(standing.agent, standing.actor);
				}),
			),

		create: ({ workspace, agent }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(workspace, "agent.create");
					yield* modelProviders.requireEnabled(workspaceId, agent.model);
					const made = yield* agents.create(workspaceId, { createdById: actor.userId, agent });
					return toAgent(made, { actor, pinned: true });
				}),
			),

		setPinned: ({ agentId, pinned }) =>
			operation(
				"setPinned",
				Effect.gen(function* () {
					const { agent, actor } = yield* authorization.agent(agentId, "agent.read");
					yield* agents.setPinned({
						workspaceId: agent.workspaceId,
						userId: actor.userId,
						agentId: agent.id,
						pinned,
					});
					return yield* shown(agent, actor);
				}),
			),

		ensureAssistant: ({ workspace, model }) =>
			operation(
				"ensureAssistant",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"workspace.read",
					);
					if (model !== undefined) yield* modelProviders.requireEnabled(workspaceId, model);
					const assistant = yield* agents.provisionPersonalAssistant({
						workspaceId,
						userId: actor.userId,
						model,
					});
					return toAgent(assistant, { actor });
				}),
			),

		update: ({ agentId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const { agent, actor } = yield* authorization.agent(agentId, "agent.update");
					if (Object.values(changes).every((value) => value === undefined)) {
						return yield* new EmptyAgentUpdate();
					}
					if (agent.assistantOf !== null) yield* requireAssistantLookOnly(changes);
					if (changes.usesSandbox !== undefined && changes.usesSandbox !== agent.usesSandbox) {
						yield* authorization.agent(agentId, "sandbox.manage");
					}
					// A cleared model names none to check.
					if (changes.model != null) {
						yield* modelProviders.requireEnabled(agent.workspaceId, changes.model);
					}
					return yield* shown(yield* agents.update(agent.workspaceId, agent.id, changes), actor);
				}),
			),

		remove: ({ agentId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { agent } = yield* authorization.agent(agentId, "agent.delete");
					// Deleting the bot deletes its computer's record, so its machine goes first.
					yield* agentSandboxes.destroy({ workspaceId: agent.workspaceId, agentId: agent.id });
					yield* agents.remove(agent.workspaceId, agent.id);
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
		AgentRepository.layer,
		ModelProviderRepository.layer,
		AgentSandboxes.layer,
	]),
);

/** What a Personal Assistant's person may change of it: its name and its look. */
const ASSISTANT_LOOK: ReadonlySet<keyof AgentUpdate> = new Set(["name", "color", "face", "shape"]);

/**
 * Refuses `changes` to a Personal Assistant that change more than its look:
 * Sugabots manages the rest of it. Its connections are changed apart.
 */
const requireAssistantLookOnly = (changes: AgentUpdate) =>
	Effect.gen(function* () {
		const changed = (Object.keys(changes) as (keyof AgentUpdate)[]).filter(
			(field) => changes[field] !== undefined,
		);
		// A Personal Assistant is always its person's alone.
		if (changed.includes("visibility")) return yield* new AssistantStaysPrivate();
		// What a Personal Assistant is told is Sugabots', not its person's.
		if (changed.includes("prompt")) return yield* new AssistantInstructionsManaged();
		if (changed.some((field) => !ASSISTANT_LOOK.has(field))) return yield* new AssistantManaged();
	});

/** An agent update that names nothing to change. */
export class EmptyAgentUpdate extends Data.TaggedError("EmptyAgentUpdate") implements UserFacing {
	get userMessage() {
		return userText`Nothing to change`;
	}
}

/** A Personal Assistant's instructions are written and kept by Sugabots. */
export class AssistantInstructionsManaged
	extends Data.TaggedError("AssistantInstructionsManaged")
	implements UserFacing
{
	get userMessage() {
		return userText`A Personal Assistant's instructions are kept by Sugabots, so they can't be changed`;
	}
}

/** Sugabots manages a Personal Assistant: its person changes only its name, its look and its connections. */
export class AssistantManaged extends Data.TaggedError("AssistantManaged") implements UserFacing {
	get userMessage() {
		return userText`Only a Personal Assistant's name, look and connections can be changed`;
	}
}

/** A Personal Assistant is only ever its person's, so it can't be made public. */
export class AssistantStaysPrivate
	extends Data.TaggedError("AssistantStaysPrivate")
	implements UserFacing
{
	get userMessage() {
		return userText`A Personal Assistant is only ever yours`;
	}
}
