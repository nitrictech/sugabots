import type { Bot, NamedPerson, SystemBot } from "@sugabots/contracts";
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { Effect } from "effect";
import { reachesBotFor } from "../../authorization/access.ts";
import { type Actor, managesEveryBot } from "../../authorization/permissions.ts";
import { query } from "../../database/database.ts";
import { bot } from "../../database/schema.ts";
import { creatorOf, defaultProjectIdOf, personFacingBotRow, pinnedBy, toBot } from "./bot.ts";
import { SYSTEM_BOTS } from "./system-bots.ts";

/**
 * The bots in a workspace that `actor` sees, by name: those they reach, and,
 * for an administrator, every private bot too, which they see listed but
 * can't open. Each says whether `actor` pinned it. System bots are not here.
 */
export const visiblePersonFacingBots = (workspaceId: string, actor: Actor) =>
	query((db) =>
		db
			.select(shownColumns(actor))
			.from(bot)
			.where(
				and(
					eq(bot.workspaceId, workspaceId),
					isNull(bot.systemBotKey),
					managesEveryBot(actor)
						? or(isNull(bot.assistantOf), eq(bot.assistantOf, actor.personId))
						: reachesBotFor(bot.id, actor.personId),
				),
			)
			.orderBy(asc(bot.name)),
	).pipe(Effect.map((rows): Bot[] => rows.flatMap((row) => shownTo(row, actor) ?? [])));

/**
 * The bot `botId` as `actor` is shown it, with whether they pinned it, or
 * nothing for a system bot or one that is gone. Whether `actor` may see it is
 * the caller's to decide.
 */
export const personFacingBot = (botId: string, actor: Actor) =>
	query((db) => db.select(shownColumns(actor)).from(bot).where(eq(bot.id, botId)).limit(1)).pipe(
		Effect.map(([row]) => (row ? shownTo(row, actor) : undefined)),
	);

/** What a bot is shown with: its row, whether `actor` pinned it, its default project and who added it. */
const shownColumns = (actor: Actor) => ({
	bot,
	pinned: pinnedBy(bot.id, actor.personId),
	defaultProjectId: defaultProjectIdOf(bot.id),
	createdBy: creatorOf(bot),
});

function shownTo(
	row: {
		bot: typeof bot.$inferSelect;
		pinned: boolean;
		defaultProjectId: string;
		createdBy: NamedPerson | null;
	},
	actor: Actor,
): Bot | undefined {
	const shown = personFacingBotRow(row.bot);
	return (
		shown &&
		toBot(
			{ ...shown, defaultProjectId: row.defaultProjectId, createdBy: row.createdBy },
			{ actor, pinned: row.pinned },
		)
	);
}

/**
 * Every system bot the product defines, with the model the workspace chose
 * for it. The name, face and order come from the definitions; a workspace
 * missing a row reads as one that has not set that bot up.
 */
export const systemBots = (workspaceId: string) =>
	query((db) =>
		db
			.select({ key: bot.systemBotKey, model: bot.model })
			.from(bot)
			.where(and(eq(bot.workspaceId, workspaceId), isNotNull(bot.systemBotKey))),
	).pipe(
		Effect.map((rows): SystemBot[] => {
			const modelOf = new Map(rows.map((row) => [row.key, row.model]));
			return SYSTEM_BOTS.map((definition) => ({
				key: definition.key,
				name: definition.name,
				description: definition.description,
				color: definition.color,
				eyes: definition.eyes,
				shape: definition.shape,
				model: modelOf.get(definition.key) ?? null,
			}));
		}),
	);
