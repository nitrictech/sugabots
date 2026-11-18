import type { Bot, SystemBot } from "@sugabots/contracts";
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { Effect } from "effect";
import { reachesBotFor } from "../../authorization/access.ts";
import { type Actor, managesEveryBot } from "../../authorization/permissions.ts";
import { query } from "../../database/database.ts";
import { bot, pinnedBot } from "../../database/schema.ts";
import { personFacingBotRow, toBot } from "./bot.ts";
import { SYSTEM_BOTS } from "./system-bots.ts";

/**
 * The bots in a workspace that `actor` sees, by name: those they reach, and,
 * for an administrator, every private bot too, which they see listed but
 * can't open. Each says whether `actor` pinned it. System bots are not here.
 */
export const visiblePersonFacingBots = (workspaceId: string, actor: Actor) =>
	query((db) =>
		db
			.select({ bot, pinnedAt: pinnedBot.createdAt })
			.from(bot)
			.leftJoin(pinnedBot, and(eq(pinnedBot.botId, bot.id), eq(pinnedBot.userId, actor.userId)))
			.where(
				and(
					eq(bot.workspaceId, workspaceId),
					isNull(bot.systemBotKey),
					managesEveryBot(actor)
						? or(isNull(bot.assistantOf), eq(bot.assistantOf, actor.userId))
						: reachesBotFor(bot.id, actor.userId),
				),
			)
			.orderBy(asc(bot.name)),
	).pipe(
		Effect.map((rows): Bot[] =>
			rows.flatMap((row) => {
				const bot = personFacingBotRow(row.bot);
				return bot ? [toBot(bot, { actor, pinned: row.pinnedAt !== null })] : [];
			}),
		),
	);

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
				face: definition.face,
				shape: definition.shape,
				model: modelOf.get(definition.key) ?? null,
			}));
		}),
	);
