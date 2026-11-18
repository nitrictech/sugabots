export * as AgentRepository from "./agent-repository.ts";

import {
	type AgentUpdate,
	colorFromText,
	handleFromName,
	isGroupMentionHandle,
	type NewAgent,
	type SystemAgentKey,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import {
	type QueryFailure,
	query,
	queryCatching,
	serviceOperations,
	transaction,
} from "../../database/database.ts";
import { violatedUniqueConstraint } from "../../database/errors.ts";
import { agent, pinnedAgent, podAgent } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { type CrewAgentRow, crewAgentRow } from "./agent.ts";
import { INTERVIEW_PROMPT } from "./interview-prompt.ts";
import {
	findRunnableSystemAgent,
	SYSTEM_AGENTS,
	type SystemAgentDefinition,
} from "./system-agents.ts";

/**
 * The only writer of `agent` and `pinned_agent`: the bots people make, each
 * person's Personal Assistant, and the workspace's system bots, of which only
 * the model ever changes.
 */
export interface Interface {
	/**
	 * Creates a bot, pinned for its creator. Without a prompt it starts with
	 * `INTERVIEW_PROMPT`.
	 */
	readonly create: (
		workspaceId: string,
		input: { createdById: string; agent: NewAgent },
	) => Effect.Effect<CrewAgentRow, AgentNameTaken | AgentHandleReserved>;
	readonly update: (
		workspaceId: string,
		agentId: string,
		changes: AgentUpdate,
	) => Effect.Effect<
		CrewAgentRow,
		AgentNameTaken | AgentHandleReserved | AgentGone | SystemAgentImmutable
	>;
	readonly remove: (
		workspaceId: string,
		agentId: string,
	) => Effect.Effect<void, SystemAgentImmutable>;
	/**
	 * `userId`'s Personal Assistant, made on `model`, or with no model, if they
	 * have none. One they have is returned exactly as they left it.
	 */
	readonly provisionPersonalAssistant: (input: {
		workspaceId: string;
		userId: string;
		model?: string;
	}) => Effect.Effect<CrewAgentRow>;
	/** Pins or unpins the bot for `userId`. Pinning one already pinned changes nothing. */
	readonly setPinned: (input: {
		workspaceId: string;
		userId: string;
		agentId: string;
		pinned: boolean;
	}) => Effect.Effect<void>;
	/** Whether `userId` pinned the bot. */
	readonly isPinned: (userId: string, agentId: string) => Effect.Effect<boolean>;
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
	/** Points every crew agent on model `from` at model `to`, and returns how many moved. */
	readonly moveCrewAgentsToModel: (
		workspaceId: string,
		from: string,
		to: string,
	) => Effect.Effect<number>;
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
					createdById,
					name: definition.name,
					handle: handleFromName(definition.name),
					systemAgentKey: definition.key,
					description: definition.description,
					color: definition.color,
					face: definition.face,
					shape: definition.shape,
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
						const handle = input.handle ?? handleFromName(input.name);
						if (isReservedHandle(handle)) return yield* new AgentHandleReserved({ handle });
						const [row] = yield* queryCatching(
							(db) =>
								db
									.insert(agent)
									.values({
										workspaceId,
										createdById,
										name: input.name,
										handle,
										description: input.description ?? null,
										color: input.color ?? colorFromText(input.name),
										face: input.face ?? "pill",
										shape: input.shape ?? "circle",
										model: input.model,
										prompt: input.prompt ?? INTERVIEW_PROMPT,
										disabledTools: input.disabledTools ?? [],
										usesSandbox: input.usesSandbox ?? false,
										naturalBrowsing: input.naturalBrowsing ?? false,
										visibility: input.visibility ?? "public",
									})
									.returning(),
							(failure) => nameTaken(failure, { name: input.name, handle }),
						);
						const crew = row && crewAgentRow(row);
						if (!crew) {
							return yield* Effect.die(new Error("Agent insert returned no crew row"));
						}
						yield* query((db) =>
							db.insert(pinnedAgent).values({ workspaceId, userId: createdById, agentId: crew.id }),
						);
						return crew;
					}),
				),
			),

		update: (workspaceId, agentId, changes) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						// A system agent's one changeable setting, its model, belongs to the
						// workspace and is set through `setSystemAgentModel`.
						if (yield* isSystemAgent(workspaceId, agentId)) {
							return yield* new SystemAgentImmutable();
						}
						if (changes.handle !== undefined && isReservedHandle(changes.handle)) {
							return yield* new AgentHandleReserved({ handle: changes.handle });
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
						// Only public bots are in channels.
						if (crew.visibility === "private") {
							yield* query((db) => db.delete(podAgent).where(eq(podAgent.agentId, crew.id)));
						}
						return crew;
					}),
				),
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

		provisionPersonalAssistant: ({ workspaceId, userId, model }) =>
			operation(
				"provisionPersonalAssistant",
				Effect.gen(function* () {
					const [created] = yield* query((db) =>
						db
							.insert(agent)
							.values({
								workspaceId,
								createdById: userId,
								assistantOf: userId,
								visibility: "private",
								name: "Personal Assistant",
								handle: PERSONAL_ASSISTANT_HANDLE,
								description: "Your guide to the workspace.",
								color: "sky",
								face: "pill",
								shape: "circle",
								model: model ?? null,
								prompt: "",
							})
							.onConflictDoNothing({
								target: [agent.workspaceId, agent.assistantOf],
								where: sql`${agent.assistantOf} is not null`,
							})
							.returning(),
					);
					const [assistant] = created
						? [created]
						: yield* query((db) =>
								db
									.select()
									.from(agent)
									.where(and(eq(agent.workspaceId, workspaceId), eq(agent.assistantOf, userId)))
									.limit(1),
							);
					const crew = assistant && crewAgentRow(assistant);
					if (!crew) {
						return yield* Effect.die(new Error("Personal Assistant could not be provisioned"));
					}
					return crew;
				}),
			),

		setPinned: ({ workspaceId, userId, agentId, pinned }) =>
			operation(
				"setPinned",
				query((db) =>
					pinned
						? db.insert(pinnedAgent).values({ workspaceId, userId, agentId }).onConflictDoNothing()
						: db
								.delete(pinnedAgent)
								.where(and(eq(pinnedAgent.userId, userId), eq(pinnedAgent.agentId, agentId))),
				).pipe(Effect.asVoid),
			),

		isPinned: (userId, agentId) =>
			operation(
				"isPinned",
				query((db) =>
					db
						.select({ agentId: pinnedAgent.agentId })
						.from(pinnedAgent)
						.where(and(eq(pinnedAgent.userId, userId), eq(pinnedAgent.agentId, agentId)))
						.limit(1),
				).pipe(Effect.map((rows) => rows.length > 0)),
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

		moveCrewAgentsToModel: (workspaceId, from, to) =>
			operation(
				"moveCrewAgentsToModel",
				query((db) =>
					db
						.update(agent)
						.set({ model: to })
						.where(
							and(
								eq(agent.workspaceId, workspaceId),
								isNull(agent.systemAgentKey),
								eq(agent.model, from),
							),
						)
						.returning({ id: agent.id }),
				).pipe(Effect.map((rows) => rows.length)),
			),

		runnableSystemAgent: (workspaceId, key) =>
			operation(
				"runnableSystemAgent",
				query((db) => findRunnableSystemAgent(db, workspaceId, key)),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** Another bot in the workspace already has this name or handle. */
export class AgentNameTaken
	extends Data.TaggedError("AgentNameTaken")<{
		readonly field: "name" | "handle";
		readonly value: string;
	}>
	implements UserFacing
{
	override get message() {
		return `An agent with the ${this.field} "${this.value}" already exists in this workspace`;
	}
	get userMessage() {
		return this.field === "name"
			? userText`Another bot in this workspace already has that name`
			: userText`Another bot in this workspace already has that handle`;
	}
}

/** A handle no bot people make may take: see `isReservedHandle`. */
export class AgentHandleReserved
	extends Data.TaggedError("AgentHandleReserved")<{ readonly handle: string }>
	implements UserFacing
{
	override get message() {
		return `"${this.handle}" is a reserved handle`;
	}
	get userMessage() {
		return isGroupMentionHandle(this.handle)
			? userText`@${this.handle} mentions everyone, so it can't be a bot's handle`
			: userText`@personal-assistant is every Personal Assistant's handle, so it can't be another bot's`;
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
		return userText`No such agent`;
	}
}

/**
 * System bots are shipped by the product and belong to the workspace. The one
 * thing about one that changes, its model, is set through
 * `setSystemAgentModel`.
 */
export class SystemAgentImmutable
	extends Data.TaggedError("SystemAgentImmutable")
	implements UserFacing
{
	get userMessage() {
		return userText`A system bot is configured for the workspace`;
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
		return userText`This workspace has no ${this.key} agent`;
	}
}

/**
 * Every Personal Assistant's handle; only its person ever talks to it, so it
 * needn't be unique, but no other bot may take it, so it names one bot for
 * each person.
 */
const PERSONAL_ASSISTANT_HANDLE = "personal-assistant";

/**
 * Whether no bot people make may take `handle`: `@here` and `@channel`
 * mention everyone, and `personal-assistant` is each person's Personal
 * Assistant.
 */
function isReservedHandle(handle: string): boolean {
	return isGroupMentionHandle(handle) || handle === PERSONAL_ASSISTANT_HANDLE;
}

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
