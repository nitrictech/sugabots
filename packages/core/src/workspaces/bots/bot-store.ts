export {
	BotGone,
	BotHandleReserved,
	BotNameTaken,
	SystemBotImmutable,
	SystemBotMissing,
} from "@sugabots/contracts/errors/bots";
export * as BotStore from "./bot-store.ts";

import {
	type BotUpdate,
	colorFromText,
	handleFromName,
	isGroupMentionHandle,
	type NewBot,
	type SystemBotKey,
} from "@sugabots/contracts";
import {
	BotGone,
	BotHandleReserved,
	BotNameTaken,
	SystemBotImmutable,
	SystemBotMissing,
} from "@sugabots/contracts/errors/bots";
import { and, eq, isNotNull, isNull, ne, type SQL, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
	type QueryFailure,
	query,
	queryCatching,
	serviceOperations,
	type Transaction,
	transaction,
} from "../../database/database.ts";
import { violatedUniqueConstraint } from "../../database/errors.ts";
import { bot, pinnedBot, projectBot } from "../../database/schema.ts";
import { type LeadsProjects, refuseWhileLeading } from "../projects/project-leads.ts";
import { defaultProjectIdOf, type MemberFacingBotRow, memberFacingBotRow } from "./bot.ts";
import { INTERVIEW_PROMPT } from "./interview-prompt.ts";
import { SYSTEM_BOTS } from "./system-bots.ts";

/**
 * The only writer of `bot` and `pinned_bot`: the bots members make, each
 * member's Personal Assistant, and the workspace's system bots, of which only
 * the model ever changes. Each bot but a system bot gets its default project
 * as it is made, from the `bot_default_project` trigger, and it goes with it.
 */
export interface Interface {
	/**
	 * Creates a bot, pinned for its creator. Without instructions it starts with
	 * `INTERVIEW_PROMPT`.
	 */
	readonly create: (
		workspaceId: string,
		input: { createdById: string; bot: NewBot },
	) => Effect.Effect<MemberFacingBotRow, BotNameTaken | BotHandleReserved>;
	/**
	 * Refused when it makes the bot personal while it leads a project members
	 * made (see `refuseWhileLeading`), naming to `viewerId` the projects they see.
	 */
	readonly update: (
		workspaceId: string,
		botId: string,
		changes: BotUpdate,
		viewerId: string,
	) => Effect.Effect<
		MemberFacingBotRow,
		BotNameTaken | BotHandleReserved | BotGone | SystemBotImmutable | LeadsProjects
	>;
	/**
	 * Deletes the bot, its default project with it, after `beforeDeleting`.
	 * Refused while the bot leads a project members made (see
	 * `refuseWhileLeading`), naming to `viewerId` the projects they see.
	 * `beforeDeleting` runs once the bot is locked and found free to delete, and
	 * the lock is held until the deletion commits, so no project can choose
	 * the bot as lead in between; when it fails, the bot is kept.
	 */
	readonly remove: <E, R>(
		workspaceId: string,
		botId: string,
		viewerId: string,
		beforeDeleting: Effect.Effect<void, E, R>,
	) => Effect.Effect<void, SystemBotImmutable | LeadsProjects | E, Exclude<R, Transaction>>;
	/**
	 * `memberId`'s Personal Assistant, made on `model`, or with no model, if they
	 * have none. One they have is returned exactly as they left it.
	 */
	readonly provisionPersonalAssistant: (input: {
		workspaceId: string;
		memberId: string;
		model?: string;
	}) => Effect.Effect<MemberFacingBotRow>;
	/** Pins or unpins the bot for `memberId`. Pinning one already pinned changes nothing. */
	readonly setPinned: (input: {
		workspaceId: string;
		memberId: string;
		botId: string;
		pinned: boolean;
	}) => Effect.Effect<void>;
	/** Creates the system bots of a workspace being made, with no model. */
	readonly createSystemBots: (input: {
		workspaceId: string;
		createdById: string;
	}) => Effect.Effect<void>;
	/** Points a system bot at a model. */
	readonly setSystemBotModel: (
		workspaceId: string,
		key: SystemBotKey,
		model: string,
	) => Effect.Effect<void, SystemBotMissing>;
	/** Points every system bot the workspace has at `model`. */
	readonly setAllSystemBotModels: (workspaceId: string, model: string) => Effect.Effect<void>;
	/**
	 * Points every system bot with no model at `model`: how they are set up
	 * when the workspace first offers one. One already on a model keeps it.
	 */
	readonly fillMissingSystemBotModels: (workspaceId: string, model: string) => Effect.Effect<void>;
	/**
	 * Points every Personal Assistant with no model at `model`: those made
	 * before the workspace offered one. One already on a model keeps it.
	 */
	readonly fillMissingAssistantModels: (workspaceId: string, model: string) => Effect.Effect<void>;
	/** Points every bot members talk to on model `from` at model `to`, and returns how many moved. */
	readonly moveMemberFacingBotsToModel: (
		workspaceId: string,
		from: string,
		to: string,
	) => Effect.Effect<number>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BotStore") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("BotStore");

	const setSystemBotModels = (workspaceId: string, model: string, only?: SQL) =>
		query((db) =>
			db
				.update(bot)
				.set({ model })
				.where(and(eq(bot.workspaceId, workspaceId), isNotNull(bot.systemBotKey), only)),
		).pipe(Effect.asVoid);

	const isSystemBot = (workspaceId: string, botId: string) =>
		query((db) =>
			db
				.select({ systemBotKey: bot.systemBotKey })
				.from(bot)
				.where(and(eq(bot.id, botId), eq(bot.workspaceId, workspaceId)))
				.limit(1),
		).pipe(Effect.map(([row]) => Boolean(row?.systemBotKey)));

	return Service.of({
		create: (workspaceId, { createdById, bot: input }) =>
			operation(
				"create",
				transaction(
					Effect.gen(function* () {
						const handle = input.handle ?? handleFromName(input.name);
						if (isReservedHandle(handle)) return yield* new BotHandleReserved({ handle });
						const [row] = yield* queryCatching(
							(db) =>
								db
									.insert(bot)
									.values({
										workspaceId,
										createdById,
										name: input.name,
										handle,
										description: input.description ?? null,
										color: input.color ?? colorFromText(input.name),
										eyes: input.eyes ?? "pill",
										shape: input.shape ?? "circle",
										model: input.model,
										instructions: input.instructions ?? INTERVIEW_PROMPT,
										disabledTools: input.disabledTools ?? [],
										usesComputer: input.usesComputer ?? false,
										naturalBrowsing: input.naturalBrowsing ?? false,
										visibility: input.visibility ?? "public",
									})
									.returning(),
							(failure) => nameTaken(failure, { name: input.name, handle }),
						);
						const created = row && memberFacingBotRow(row);
						if (!created) {
							return yield* Effect.die(new Error("Bot insert returned a system bot row"));
						}
						yield* query((db) =>
							db
								.insert(pinnedBot)
								.values({ workspaceId, memberId: createdById, botId: created.id }),
						);
						return created;
					}),
				),
			),

		update: (workspaceId, botId, changes, viewerId) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						// A system bot's one changeable setting, its model, belongs to the
						// workspace and is set through `setSystemBotModel`.
						if (yield* isSystemBot(workspaceId, botId)) {
							return yield* new SystemBotImmutable();
						}
						if (changes.handle !== undefined && isReservedHandle(changes.handle)) {
							return yield* new BotHandleReserved({ handle: changes.handle });
						}
						const [row] = yield* queryCatching(
							(db) =>
								db
									.update(bot)
									.set(changes)
									.where(and(eq(bot.id, botId), eq(bot.workspaceId, workspaceId)))
									.returning(),
							(failure) => nameTaken(failure, changes),
						);
						const updated = row && memberFacingBotRow(row);
						if (!updated) {
							return yield* new BotGone({ botId });
						}
						// Only public bots are in projects members made, so one made personal
						// leaves them, unless it leads one. Its default project it keeps.
						if (updated.visibility === "personal") {
							yield* refuseWhileLeading(updated.id, { viewerId });
							yield* query((db) =>
								db
									.delete(projectBot)
									.where(
										and(
											eq(projectBot.botId, updated.id),
											ne(projectBot.projectId, defaultProjectIdOf(projectBot.botId)),
										),
									),
							);
						}
						return updated;
					}),
				),
			),

		remove: (workspaceId, botId, viewerId, beforeDeleting) =>
			operation(
				"remove",
				transaction(
					Effect.gen(function* () {
						if (yield* isSystemBot(workspaceId, botId)) {
							return yield* new SystemBotImmutable();
						}
						const named = and(eq(bot.id, botId), eq(bot.workspaceId, workspaceId));
						// Locked first, and held through `beforeDeleting`, so a project
						// choosing it as lead waits until it is gone.
						yield* query((db) => db.select({ id: bot.id }).from(bot).where(named).for("update"));
						yield* refuseWhileLeading(botId, { viewerId });
						yield* beforeDeleting;
						yield* query((db) => db.delete(bot).where(named));
					}),
				),
			),

		provisionPersonalAssistant: ({ workspaceId, memberId, model }) =>
			operation(
				"provisionPersonalAssistant",
				Effect.gen(function* () {
					const [created] = yield* query((db) =>
						db
							.insert(bot)
							.values({
								workspaceId,
								createdById: memberId,
								assistantOf: memberId,
								visibility: "personal",
								name: "Personal Assistant",
								handle: PERSONAL_ASSISTANT_HANDLE,
								description: "Your guide to the workspace.",
								color: "sky",
								eyes: "pill",
								shape: "circle",
								model: model ?? null,
								instructions: "",
							})
							.onConflictDoNothing({
								target: [bot.workspaceId, bot.assistantOf],
								where: sql`${bot.assistantOf} is not null`,
							})
							.returning(),
					);
					const [assistant] = created
						? [created]
						: yield* query((db) =>
								db
									.select()
									.from(bot)
									.where(and(eq(bot.workspaceId, workspaceId), eq(bot.assistantOf, memberId)))
									.limit(1),
							);
					const provisioned = assistant && memberFacingBotRow(assistant);
					if (!provisioned) {
						return yield* Effect.die(new Error("Personal Assistant could not be provisioned"));
					}
					return provisioned;
				}),
			),

		setPinned: ({ workspaceId, memberId, botId, pinned }) =>
			operation(
				"setPinned",
				query((db) =>
					pinned
						? db.insert(pinnedBot).values({ workspaceId, memberId, botId }).onConflictDoNothing()
						: db
								.delete(pinnedBot)
								.where(and(eq(pinnedBot.memberId, memberId), eq(pinnedBot.botId, botId))),
				).pipe(Effect.asVoid),
			),

		createSystemBots: ({ workspaceId, createdById }) =>
			operation(
				"createSystemBots",
				query((db) =>
					db.insert(bot).values(
						SYSTEM_BOTS.map((definition) => ({
							workspaceId,
							createdById,
							name: definition.name,
							handle: handleFromName(definition.name),
							systemBotKey: definition.key,
							description: definition.description,
							color: definition.color,
							eyes: definition.eyes,
							shape: definition.shape,
							model: null,
							instructions: definition.instructions,
						})),
					),
				).pipe(Effect.asVoid),
			),

		setSystemBotModel: (workspaceId, key, model) =>
			operation(
				"setSystemBotModel",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.update(bot)
							.set({ model })
							.where(and(eq(bot.workspaceId, workspaceId), eq(bot.systemBotKey, key)))
							.returning({ id: bot.id }),
					);
					if (!row) {
						return yield* new SystemBotMissing({ key });
					}
				}),
			),

		setAllSystemBotModels: (workspaceId, model) =>
			operation("setAllSystemBotModels", setSystemBotModels(workspaceId, model)),

		fillMissingSystemBotModels: (workspaceId, model) =>
			operation(
				"fillMissingSystemBotModels",
				setSystemBotModels(workspaceId, model, isNull(bot.model)),
			),

		fillMissingAssistantModels: (workspaceId, model) =>
			operation(
				"fillMissingAssistantModels",
				query((db) =>
					db
						.update(bot)
						.set({ model })
						.where(
							and(eq(bot.workspaceId, workspaceId), isNotNull(bot.assistantOf), isNull(bot.model)),
						),
				).pipe(Effect.asVoid),
			),

		moveMemberFacingBotsToModel: (workspaceId, from, to) =>
			operation(
				"moveMemberFacingBotsToModel",
				query((db) =>
					db
						.update(bot)
						.set({ model: to })
						.where(
							and(eq(bot.workspaceId, workspaceId), isNull(bot.systemBotKey), eq(bot.model, from)),
						)
						.returning({ id: bot.id }),
				).pipe(Effect.map((rows) => rows.length)),
			),
	});
});

export const layer = Layer.effect(Service, make);

/**
 * Every Personal Assistant's handle; only its member ever talks to it, so it
 * needn't be unique, but no other bot may take it, so it names one bot for
 * each member.
 */
const PERSONAL_ASSISTANT_HANDLE = "personal-assistant";

/**
 * Whether no bot members make may take `handle`: `@here` and `@channel`
 * mention everyone, and `personal-assistant` is each member's Personal
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
): BotNameTaken | undefined {
	const constraint = violatedUniqueConstraint(failure);
	if (constraint === "bot_name_idx" && written.name !== undefined) {
		return new BotNameTaken({ field: "name", value: written.name });
	}
	if (constraint === "bot_handle_idx" && written.handle !== undefined) {
		return new BotNameTaken({ field: "handle", value: written.handle });
	}
	return undefined;
}
