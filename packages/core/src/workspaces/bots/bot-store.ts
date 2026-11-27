export {
	BotGone,
	BotHandleReserved,
	BotNameTaken,
	PersonalVisibilityFixed,
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
	PersonalVisibilityFixed,
	SystemBotImmutable,
	SystemBotMissing,
} from "@sugabots/contracts/errors/bots";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, asc, eq, isNotNull, isNull, like, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
	type QueryFailure,
	query,
	queryCatching,
	serviceOperations,
	Transaction,
	transaction,
} from "../../database/database.ts";
import { violatedUniqueConstraint } from "../../database/errors.ts";
import { bot, membership, pinnedBot } from "../../database/schema.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { refuseWhileLeading } from "../projects/project-leads.ts";
import { changesPersonal, type MemberFacingBotRow, memberFacingBotRow } from "./bot.ts";
import { INTERVIEW_PROMPT } from "./interview-prompt.ts";
import { SYSTEM_BOTS } from "./system-bots.ts";

/**
 * The only writer of `bot` and `pinned_bot`: the bots members make, each
 * member's Personal Assistants, and the workspace's system bots, of which only
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
	/** Refused when it would make the bot personal, or stop it being personal. */
	readonly update: (
		workspaceId: string,
		botId: string,
		changes: BotUpdate,
	) => Effect.Effect<
		MemberFacingBotRow,
		BotNameTaken | BotHandleReserved | BotGone | SystemBotImmutable | PersonalVisibilityFixed
	>;
	/** Removes the bot and its default project once the computer is gone. */
	readonly remove: (workspaceId: string, botId: string) => Effect.Effect<void, SystemBotImmutable>;
	/**
	 * `memberId`'s oldest Personal Assistant, made on `model`, or with no model,
	 * if they have none. One they have is returned exactly as they left it.
	 * Calls at once for the same member make one between them. A member who has
	 * left, or whose departure commits while this waits for it, is refused as
	 * someone outside the workspace.
	 */
	readonly ensurePersonalAssistant: (input: {
		workspaceId: string;
		memberId: string;
		model?: string;
	}) => Effect.Effect<MemberFacingBotRow, ResourceHidden>;
	/**
	 * Another Personal Assistant for `memberId`, on `model` or none, named and
	 * addressed apart from their others: "Personal Assistant 2" at
	 * `@personal-assistant-2`, by the lowest number whose handle is free.
	 * Refused as `ensurePersonalAssistant` is for a member who has left.
	 */
	readonly addPersonalAssistant: (input: {
		workspaceId: string;
		memberId: string;
		model?: string;
	}) => Effect.Effect<MemberFacingBotRow, ResourceHidden>;
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

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BotStore") {
	declare readonly [Tier]: "process";
}

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

		update: (workspaceId, botId, changes) =>
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
						if (changes.visibility !== undefined) {
							const [current] = yield* query((db) =>
								db
									.select({ visibility: bot.visibility })
									.from(bot)
									.where(and(eq(bot.id, botId), eq(bot.workspaceId, workspaceId)))
									.for("update"),
							);
							if (current && changesPersonal(current.visibility, changes.visibility)) {
								return yield* new PersonalVisibilityFixed();
							}
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
						return updated;
					}),
				),
			),

		remove: (workspaceId, botId) =>
			operation(
				"remove",
				transaction(
					Effect.gen(function* () {
						if (yield* isSystemBot(workspaceId, botId)) return yield* new SystemBotImmutable();
						yield* query((db) =>
							db.delete(bot).where(and(eq(bot.id, botId), eq(bot.workspaceId, workspaceId))),
						);
					}),
				),
			),

		ensurePersonalAssistant: (member) =>
			operation(
				"ensurePersonalAssistant",
				transaction(
					Effect.gen(function* () {
						const assistants = yield* lockedPersonalAssistants(member);
						const [oldest] = assistants;
						return oldest ?? (yield* insertPersonalAssistant(member, assistants));
					}),
				),
			),

		addPersonalAssistant: (member) =>
			operation(
				"addPersonalAssistant",
				transaction(
					Effect.flatMap(lockedPersonalAssistants(member), (assistants) =>
						insertPersonalAssistant(member, assistants),
					),
				),
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

export const layer = processLayer(Layer.effect(Service, make));

/**
 * A member's Personal Assistants, oldest first, with their membership's row
 * locked, as a departure locks it, so two calls for one member take turns and
 * the second sees what the first made. A member no longer in the workspace,
 * their departure committed while this waited on its lock included, is refused
 * as anyone outside it is.
 */
const lockedPersonalAssistants = (member: { workspaceId: string; memberId: string }) =>
	Effect.gen(function* () {
		const [locked] = yield* query((db) =>
			db
				.select({ id: membership.id })
				.from(membership)
				.where(
					and(
						eq(membership.workspaceId, member.workspaceId),
						eq(membership.memberId, member.memberId),
						eq(membership.leaving, false),
					),
				)
				.for("no key update"),
		);
		if (!locked) return yield* new ResourceHidden({ resource: "workspace" });
		const rows = yield* query((db) =>
			db
				.select()
				.from(bot)
				.where(and(eq(bot.workspaceId, member.workspaceId), eq(bot.assistantOf, member.memberId)))
				.orderBy(asc(bot.createdAt), asc(bot.id)),
		);
		return rows.flatMap((row) => memberFacingBotRow(row) ?? []);
	});

/**
 * Makes `member` a Personal Assistant beside `theirs`, using the first free
 * handle. Bots made before the handles were reserved keep their addresses.
 */
const insertPersonalAssistant = (
	member: { workspaceId: string; memberId: string; model?: string },
	theirs: readonly MemberFacingBotRow[],
) =>
	Effect.gen(function* () {
		const existing = yield* query((db) =>
			db
				.select({ handle: bot.handle })
				.from(bot)
				.where(
					and(
						eq(bot.workspaceId, member.workspaceId),
						isNull(bot.assistantOf),
						isNull(bot.systemBotKey),
						like(bot.handle, `${PERSONAL_ASSISTANT_HANDLE}%`),
					),
				),
		);
		const taken = new Set([...theirs, ...existing].map(({ handle }) => handle));
		let number = 1;
		while (taken.has(personalAssistantHandle(number))) number += 1;
		const [created] = yield* query((db) =>
			db
				.insert(bot)
				.values({
					workspaceId: member.workspaceId,
					createdById: member.memberId,
					assistantOf: member.memberId,
					visibility: "personal",
					name: number === 1 ? PERSONAL_ASSISTANT_NAME : `${PERSONAL_ASSISTANT_NAME} ${number}`,
					handle: personalAssistantHandle(number),
					description: "Your guide to the workspace.",
					color: "sky",
					eyes: "pill",
					shape: "circle",
					model: member.model ?? null,
					instructions: "",
				})
				.returning(),
		);
		const made = created && memberFacingBotRow(created);
		if (!made) return yield* Effect.die(new Error("A Personal Assistant could not be made"));
		return made;
	});

const PERSONAL_ASSISTANT_NAME = "Personal Assistant";

/**
 * The first of a member's Personal Assistants' handles. Only its creator ever
 * talks to one, so they needn't be unique in the workspace, only among one
 * member's; no other bot may take one, so each names a Personal Assistant.
 */
const PERSONAL_ASSISTANT_HANDLE = "personal-assistant";

/** The handle of a member's `number`th Personal Assistant: `personal-assistant`, then `personal-assistant-2`. */
function personalAssistantHandle(number: number): string {
	return number === 1 ? PERSONAL_ASSISTANT_HANDLE : `${PERSONAL_ASSISTANT_HANDLE}-${number}`;
}

/**
 * Whether no bot members make may take `handle`: `@here` and `@channel`
 * mention everyone, and `personal-assistant`, numbered or not, addresses a
 * member's Personal Assistants.
 */
function isReservedHandle(handle: string): boolean {
	return isGroupMentionHandle(handle) || /^personal-assistant(-\d+)?$/.test(handle);
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

/** Checks the lead constraint while the workspace's lock prevents a new lead assignment. */
export const lockForRemoval = Effect.fn("BotStore.lockForRemoval")(function* (
	workspaceId: string,
	botId: string,
	viewerId: string,
) {
	yield* Transaction;
	const [locked] = yield* query((db) =>
		db
			.select({ systemBotKey: bot.systemBotKey })
			.from(bot)
			.where(and(eq(bot.id, botId), eq(bot.workspaceId, workspaceId)))
			.for("update"),
	);
	if (locked?.systemBotKey) return yield* new SystemBotImmutable();
	yield* refuseWhileLeading(botId, { viewerId });
});
