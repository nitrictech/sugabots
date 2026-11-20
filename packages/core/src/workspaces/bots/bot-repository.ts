export * as BotRepository from "./bot-repository.ts";

import {
	type BotUpdate,
	colorFromText,
	handleFromName,
	isGroupMentionHandle,
	type NewBot,
	type SystemBotKey,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, isNotNull, isNull, ne, type SQL, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
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
import type { UserFacing } from "../../user-message.ts";
import { type LeadsProjects, refuseWhileLeading } from "../projects/project-leads.ts";
import { defaultProjectIdOf, type PersonFacingBotRow, personFacingBotRow } from "./bot.ts";
import { INTERVIEW_PROMPT } from "./interview-prompt.ts";
import { SYSTEM_BOTS, type SystemBotDefinition } from "./system-bots.ts";

/**
 * The only writer of `bot` and `pinned_bot`: the bots people make, each
 * person's Personal Assistant, and the workspace's system bots, of which only
 * the model ever changes. Each bot but a system bot gets its default project
 * as it is made, from the `bot_default_project` trigger, and it goes with it.
 */
export interface Interface {
	/**
	 * Creates a bot, pinned for its creator. Without a prompt it starts with
	 * `INTERVIEW_PROMPT`.
	 */
	readonly create: (
		workspaceId: string,
		input: { createdById: string; bot: NewBot },
	) => Effect.Effect<PersonFacingBotRow, BotNameTaken | BotHandleReserved>;
	/**
	 * Refused when it makes the bot private while it leads a project people
	 * made (see `refuseWhileLeading`), naming to `viewerId` the projects they see.
	 */
	readonly update: (
		workspaceId: string,
		botId: string,
		changes: BotUpdate,
		viewerId: string,
	) => Effect.Effect<
		PersonFacingBotRow,
		BotNameTaken | BotHandleReserved | BotGone | SystemBotImmutable | LeadsProjects
	>;
	/**
	 * Deletes the bot, its default project with it, after `beforeDeleting`.
	 * Refused while the bot leads a project people made (see
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
	 * `userId`'s Personal Assistant, made on `model`, or with no model, if they
	 * have none. One they have is returned exactly as they left it.
	 */
	readonly provisionPersonalAssistant: (input: {
		workspaceId: string;
		userId: string;
		model?: string;
	}) => Effect.Effect<PersonFacingBotRow>;
	/** Pins or unpins the bot for `userId`. Pinning one already pinned changes nothing. */
	readonly setPinned: (input: {
		workspaceId: string;
		userId: string;
		botId: string;
		pinned: boolean;
	}) => Effect.Effect<void>;
	/**
	 * Creates any system bot the workspace does not have yet, with no model.
	 * An existing one is left exactly as it is, so repeating this never unsets
	 * a model an administrator chose.
	 */
	readonly ensureSystemBots: (input: {
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
	/** Points every bot people talk to on model `from` at model `to`, and returns how many moved. */
	readonly movePersonFacingBotsToModel: (
		workspaceId: string,
		from: string,
		to: string,
	) => Effect.Effect<number>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/BotRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("BotRepository");

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

	const ensureSystemBot = (
		workspaceId: string,
		createdById: string,
		definition: SystemBotDefinition,
	) =>
		query((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					createdById,
					name: definition.name,
					handle: handleFromName(definition.name),
					systemBotKey: definition.key,
					description: definition.description,
					color: definition.color,
					face: definition.face,
					shape: definition.shape,
					model: null,
					prompt: definition.prompt,
				})
				.onConflictDoNothing({ target: [bot.workspaceId, bot.systemBotKey] }),
		).pipe(Effect.asVoid);

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
										face: input.face ?? "pill",
										shape: input.shape ?? "circle",
										model: input.model,
										prompt: input.prompt ?? INTERVIEW_PROMPT,
										disabledTools: input.disabledTools ?? [],
										usesComputer: input.usesComputer ?? false,
										naturalBrowsing: input.naturalBrowsing ?? false,
										visibility: input.visibility ?? "public",
									})
									.returning(),
							(failure) => nameTaken(failure, { name: input.name, handle }),
						);
						const created = row && personFacingBotRow(row);
						if (!created) {
							return yield* Effect.die(new Error("Bot insert returned a system bot row"));
						}
						yield* query((db) =>
							db.insert(pinnedBot).values({ workspaceId, userId: createdById, botId: created.id }),
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
						const updated = row && personFacingBotRow(row);
						if (!updated) {
							return yield* new BotGone({ botId });
						}
						// Only public bots are in projects people made, so one made private
						// leaves them, unless it leads one. Its default project it keeps.
						if (updated.visibility === "private") {
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

		provisionPersonalAssistant: ({ workspaceId, userId, model }) =>
			operation(
				"provisionPersonalAssistant",
				Effect.gen(function* () {
					const [created] = yield* query((db) =>
						db
							.insert(bot)
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
									.where(and(eq(bot.workspaceId, workspaceId), eq(bot.assistantOf, userId)))
									.limit(1),
							);
					const provisioned = assistant && personFacingBotRow(assistant);
					if (!provisioned) {
						return yield* Effect.die(new Error("Personal Assistant could not be provisioned"));
					}
					return provisioned;
				}),
			),

		setPinned: ({ workspaceId, userId, botId, pinned }) =>
			operation(
				"setPinned",
				query((db) =>
					pinned
						? db.insert(pinnedBot).values({ workspaceId, userId, botId }).onConflictDoNothing()
						: db
								.delete(pinnedBot)
								.where(and(eq(pinnedBot.userId, userId), eq(pinnedBot.botId, botId))),
				).pipe(Effect.asVoid),
			),

		ensureSystemBots: ({ workspaceId, createdById }) =>
			operation(
				"ensureSystemBots",
				Effect.forEach(
					SYSTEM_BOTS,
					(definition) => ensureSystemBot(workspaceId, createdById, definition),
					{ discard: true },
				),
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

		movePersonFacingBotsToModel: (workspaceId, from, to) =>
			operation(
				"movePersonFacingBotsToModel",
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

/** Another bot in the workspace already has this name or handle. */
export class BotNameTaken
	extends Data.TaggedError("BotNameTaken")<{
		readonly field: "name" | "handle";
		readonly value: string;
	}>
	implements UserFacing
{
	override get message() {
		return `A bot with the ${this.field} "${this.value}" already exists in this workspace`;
	}
	get userMessage() {
		return this.field === "name"
			? userText`Another bot in this workspace already has that name`
			: userText`Another bot in this workspace already has that handle`;
	}
}

/** A handle no bot people make may take: see `isReservedHandle`. */
export class BotHandleReserved
	extends Data.TaggedError("BotHandleReserved")<{ readonly handle: string }>
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

/** The bot was deleted before the write reached it. */
export class BotGone
	extends Data.TaggedError("BotGone")<{ readonly botId: string }>
	implements UserFacing
{
	override get message() {
		return `No bot with the id "${this.botId}"`;
	}
	get userMessage() {
		return userText`No such bot`;
	}
}

/**
 * System bots are shipped by the product and belong to the workspace. The one
 * thing about one that changes, its model, is set through
 * `setSystemBotModel`.
 */
export class SystemBotImmutable
	extends Data.TaggedError("SystemBotImmutable")
	implements UserFacing
{
	get userMessage() {
		return userText`A system bot is configured for the workspace`;
	}
}

/**
 * The workspace has no row for this system bot. Every workspace is given
 * one when it is created, so this is a fault in the data rather than
 * something a caller can retry.
 */
export class SystemBotMissing
	extends Data.TaggedError("SystemBotMissing")<{ readonly key: SystemBotKey }>
	implements UserFacing
{
	get userMessage() {
		return userText`This workspace has no ${this.key} bot`;
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
