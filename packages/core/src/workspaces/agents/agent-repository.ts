export * as AgentRepository from "./agent-repository.ts";

import {
	type AgentUpdate,
	colorFromText,
	handleFromName,
	type NewAgent,
	type SystemAgentKey,
} from "@sugabots/contracts";
import { and, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import {
	type QueryFailure,
	query,
	queryCatching,
	serviceOperations,
	transaction,
} from "../../database/database.ts";
import { violatedUniqueConstraint } from "../../database/errors.ts";
import { agent, pod } from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { type CrewAgentRow, crewAgentRow } from "./agent.ts";
import { INTERVIEW_PROMPT } from "./interview-prompt.ts";
import {
	findRunnableSystemAgent,
	SYSTEM_AGENTS,
	type SystemAgentDefinition,
} from "./system-agents.ts";

/**
 * The only writer of `agent`: crew agents, each in one pod, the Personal
 * Assistant in each Personal pod, and the workspace's system agents, which sit
 * in no pod and of which only the model ever changes.
 */
export interface Interface {
	/**
	 * Creates a crew agent in `agent.podId`, which must be in the workspace.
	 * Without a prompt it starts with `INTERVIEW_PROMPT`.
	 */
	readonly create: (
		workspaceId: string,
		input: { createdById: string; agent: NewAgent },
	) => Effect.Effect<CrewAgentRow, AgentNameTaken | PodOutsideWorkspace>;
	readonly update: (
		workspaceId: string,
		agentId: string,
		changes: AgentUpdate,
	) => Effect.Effect<CrewAgentRow, AgentNameTaken | AgentGone | SystemAgentImmutable>;
	readonly remove: (
		workspaceId: string,
		agentId: string,
	) => Effect.Effect<void, SystemAgentImmutable>;
	/**
	 * Replaces the agent's prompt and description with what its interview
	 * settled on, if its prompt is still `INTERVIEW_PROMPT`. False when it is
	 * not, so a prompt somebody wrote in the meantime is never overwritten.
	 */
	readonly finishInterview: (
		workspaceId: string,
		agentId: string,
		settled: { prompt: string; description: string },
	) => Effect.Effect<boolean>;
	/**
	 * The Personal pod's Personal Assistant, placed there on `model`, or with
	 * no model, if it is missing. It starts with `INTERVIEW_PROMPT`. One already there is returned exactly as its
	 * owner left it.
	 */
	readonly provisionPersonalAssistant: (input: {
		workspaceId: string;
		podId: string;
		userId: string;
		model?: string;
	}) => Effect.Effect<CrewAgentRow>;
	/**
	 * Creates any system agent the workspace does not have yet, with no model.
	 * An existing one is left exactly as it is, so repeating this never unsets
	 * a model an administrator chose.
	 */
	readonly ensureSystemAgents: (input: {
		workspaceId: string;
		createdById: string;
	}) => Effect.Effect<void>;
	/** Points a system agent at a model. */
	readonly setSystemAgentModel: (
		workspaceId: string,
		key: SystemAgentKey,
		model: string,
	) => Effect.Effect<void, SystemAgentMissing>;
	/** Points every system agent the workspace has at `model`. */
	readonly setAllSystemAgentModels: (workspaceId: string, model: string) => Effect.Effect<void>;
	/**
	 * Points every system agent with no model at `model`: how they are set up
	 * when the workspace first offers one. One already on a model keeps it.
	 */
	readonly fillMissingSystemAgentModels: (
		workspaceId: string,
		model: string,
	) => Effect.Effect<void>;
	/** The system agent and its model, or nothing when it is not set up. */
	readonly runnableSystemAgent: (
		workspaceId: string,
		key: SystemAgentKey,
	) => Effect.Effect<{ id: string; model: string } | undefined>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AgentRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AgentRepository");

	const setSystemAgentModels = (workspaceId: string, model: string, only?: SQL) =>
		query((db) =>
			db
				.update(agent)
				.set({ model })
				.where(and(eq(agent.workspaceId, workspaceId), isNotNull(agent.systemAgentKey), only)),
		).pipe(Effect.asVoid);

	const isSystemAgent = (workspaceId: string, agentId: string) =>
		query((db) =>
			db
				.select({ systemAgentKey: agent.systemAgentKey })
				.from(agent)
				.where(and(eq(agent.id, agentId), eq(agent.workspaceId, workspaceId)))
				.limit(1),
		).pipe(Effect.map(([row]) => Boolean(row?.systemAgentKey)));

	const ensureSystemAgent = (
		workspaceId: string,
		createdById: string,
		definition: SystemAgentDefinition,
	) =>
		query((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId: null,
					createdById,
					name: definition.name,
					handle: handleFromName(definition.name),
					systemAgentKey: definition.key,
					description: definition.description,
					color: definition.color,
					face: definition.face,
					model: null,
					prompt: definition.prompt,
				})
				.onConflictDoNothing({ target: [agent.workspaceId, agent.systemAgentKey] }),
		).pipe(Effect.asVoid);

	return Service.of({
		create: (workspaceId, { createdById, agent: input }) =>
			operation(
				"create",
				transaction(
					Effect.gen(function* () {
						const [owningPod] = yield* query((db) =>
							db
								.select({ id: pod.id })
								.from(pod)
								.where(and(eq(pod.workspaceId, workspaceId), eq(pod.id, input.podId)))
								.limit(1),
						);
						if (!owningPod) {
							return yield* new PodOutsideWorkspace();
						}

						const handle = input.handle ?? handleFromName(input.name);
						const [row] = yield* queryCatching(
							(db) =>
								db
									.insert(agent)
									.values({
										workspaceId,
										podId: input.podId,
										createdById,
										name: input.name,
										handle,
										description: input.description ?? null,
										color: input.color ?? colorFromText(input.name),
										face: input.face ?? "pill",
										model: input.model,
										prompt: input.prompt ?? INTERVIEW_PROMPT,
										disabledTools: input.disabledTools ?? [],
										usesSandbox: input.usesSandbox ?? false,
									})
									.returning(),
							(failure) => nameTaken(failure, { name: input.name, handle }),
						);
						const crew = row && crewAgentRow(row);
						if (!crew) {
							return yield* Effect.die(new Error("Agent insert returned no crew row"));
						}
						return crew;
					}),
				),
			),

		update: (workspaceId, agentId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					// A system agent's one changeable setting, its model, belongs to the
					// workspace and is set through `setSystemAgentModel`.
					if (yield* isSystemAgent(workspaceId, agentId)) {
						return yield* new SystemAgentImmutable();
					}
					const [row] = yield* queryCatching(
						(db) =>
							db
								.update(agent)
								.set(changes)
								.where(and(eq(agent.id, agentId), eq(agent.workspaceId, workspaceId)))
								.returning(),
						(failure) => nameTaken(failure, changes),
					);
					const crew = row && crewAgentRow(row);
					if (!crew) {
						return yield* new AgentGone({ agentId });
					}
					return crew;
				}),
			),

		finishInterview: (workspaceId, agentId, { prompt, description }) =>
			operation(
				"finishInterview",
				query((db) =>
					db
						.update(agent)
						.set({ prompt, description })
						.where(
							and(
								eq(agent.id, agentId),
								eq(agent.workspaceId, workspaceId),
								eq(agent.prompt, INTERVIEW_PROMPT),
							),
						)
						.returning({ id: agent.id }),
				).pipe(Effect.map((rows) => rows.length > 0)),
			),

		remove: (workspaceId, agentId) =>
			operation(
				"remove",
				Effect.gen(function* () {
					if (yield* isSystemAgent(workspaceId, agentId)) {
						return yield* new SystemAgentImmutable();
					}
					yield* query((db) =>
						db.delete(agent).where(and(eq(agent.id, agentId), eq(agent.workspaceId, workspaceId))),
					);
				}),
			),

		provisionPersonalAssistant: ({ workspaceId, podId, userId, model }) =>
			operation(
				"provisionPersonalAssistant",
				Effect.gen(function* () {
					const [created] = yield* query((db) =>
						db
							.insert(agent)
							.values({
								workspaceId,
								podId,
								createdById: userId,
								name: "Personal Assistant",
								handle: PERSONAL_ASSISTANT_KEY,
								provisionedKey: PERSONAL_ASSISTANT_KEY,
								description: "Your private assistant.",
								color: "sky",
								face: "pill",
								model: model ?? null,
								prompt: INTERVIEW_PROMPT,
							})
							.onConflictDoNothing({ target: [agent.podId, agent.provisionedKey] })
							.returning(),
					);
					const [assistant] = created
						? [created]
						: yield* query((db) =>
								db
									.select()
									.from(agent)
									.where(
										and(eq(agent.podId, podId), eq(agent.provisionedKey, PERSONAL_ASSISTANT_KEY)),
									)
									.limit(1),
							);
					const crew = assistant && crewAgentRow(assistant);
					if (!crew) {
						return yield* Effect.die(new Error("Personal Assistant could not be provisioned"));
					}
					return crew;
				}),
			),

		ensureSystemAgents: ({ workspaceId, createdById }) =>
			operation(
				"ensureSystemAgents",
				Effect.forEach(
					SYSTEM_AGENTS,
					(definition) => ensureSystemAgent(workspaceId, createdById, definition),
					{ discard: true },
				),
			),

		setSystemAgentModel: (workspaceId, key, model) =>
			operation(
				"setSystemAgentModel",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.update(agent)
							.set({ model })
							.where(and(eq(agent.workspaceId, workspaceId), eq(agent.systemAgentKey, key)))
							.returning({ id: agent.id }),
					);
					if (!row) {
						return yield* new SystemAgentMissing({ key });
					}
				}),
			),

		setAllSystemAgentModels: (workspaceId, model) =>
			operation("setAllSystemAgentModels", setSystemAgentModels(workspaceId, model)),

		fillMissingSystemAgentModels: (workspaceId, model) =>
			operation(
				"fillMissingSystemAgentModels",
				setSystemAgentModels(workspaceId, model, isNull(agent.model)),
			),

		runnableSystemAgent: (workspaceId, key) =>
			operation(
				"runnableSystemAgent",
				query((db) => findRunnableSystemAgent(db, workspaceId, key)),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** Another agent in the pod already has this name or handle. */
export class AgentNameTaken
	extends Data.TaggedError("AgentNameTaken")<{
		readonly field: "name" | "handle";
		readonly value: string;
	}>
	implements UserFacing
{
	override get message() {
		return `An agent with the ${this.field} "${this.value}" already exists in this pod`;
	}
	get userMessage() {
		return this.field === "name"
			? UserMessage.of`Another agent in this pod already has that name`
			: UserMessage.of`Another agent in this pod already has that handle`;
	}
}

/** The agent was deleted before the write reached it. */
export class AgentGone
	extends Data.TaggedError("AgentGone")<{ readonly agentId: string }>
	implements UserFacing
{
	override get message() {
		return `No agent with the id "${this.agentId}"`;
	}
	get userMessage() {
		return UserMessage.of`No such agent`;
	}
}

/** A placement names a pod in another workspace. */
export class PodOutsideWorkspace
	extends Data.TaggedError("PodOutsideWorkspace")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`That is not a pod in this workspace`;
	}
}

/**
 * System agents are shipped by the product and belong to the workspace, not to
 * a pod. The one thing about one that changes, its model, is set through
 * `setSystemAgentModel`.
 */
export class SystemAgentImmutable
	extends Data.TaggedError("SystemAgentImmutable")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`A system agent is configured for the workspace, not in a pod`;
	}
}

/**
 * The workspace has no row for this system agent. Every workspace is given
 * one when it is created, so this is a fault in the data rather than
 * something a caller can retry.
 */
export class SystemAgentMissing
	extends Data.TaggedError("SystemAgentMissing")<{ readonly key: SystemAgentKey }>
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This workspace has no ${this.key} agent`;
	}
}

/** The Personal Assistant's handle, and the key it is provisioned under once per Personal pod. */
const PERSONAL_ASSISTANT_KEY = "personal-assistant";

/**
 * The clash a write's unique violation means, for the values it wrote. Any
 * other failure is not a clash and stays a defect.
 */
function nameTaken(
	failure: QueryFailure,
	written: { name?: string; handle?: string },
): AgentNameTaken | undefined {
	const constraint = violatedUniqueConstraint(failure);
	if (constraint === "agent_name_idx" && written.name !== undefined) {
		return new AgentNameTaken({ field: "name", value: written.name });
	}
	if (constraint === "agent_handle_idx" && written.handle !== undefined) {
		return new AgentNameTaken({ field: "handle", value: written.handle });
	}
	return undefined;
}
