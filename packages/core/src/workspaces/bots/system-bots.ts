import type { BotColor, BotFace, BotShape, SystemBotKey } from "@sugabots/contracts";
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { bot } from "../../database/schema.ts";

/**
 * System bots are protected bots the product runs. A workspace owns one of
 * each, and every bot in it is served by them: nobody places, configures or
 * removes them.
 *
 * One is born without a model, since a new workspace offers none, and is given
 * the first model somebody switches on, which is the one they pick while
 * onboarding. From then on it always has one: an administrator can change it
 * but not clear it, and the workspace cannot stop offering it until the bot
 * is moved to another. Compaction runs on the model of the bot it compacts
 * for, and on its own only for a bot with none.
 */

/** The system bot that compacts what a bot reads when its conversation gets long. */
export const COMPACT_SYSTEM_BOT: SystemBotKey = "compact";

export interface SystemBotDefinition {
	/** What the system looks the bot up by. */
	key: SystemBotKey;
	name: string;
	description: string;
	color: BotColor;
	face: BotFace;
	shape: BotShape;
	prompt: string;
}

export const SYSTEM_BOTS: readonly SystemBotDefinition[] = [
	{
		key: COMPACT_SYSTEM_BOT,
		name: "Compaction",
		description: "Compacts long conversations so bots can keep reading them.",
		color: "purple",
		face: "square",
		shape: "circle",
		prompt: "Summarize what a bot needs to carry on the conversation. Do not invent details.",
	},
];

/** The workspace's system bot and the model chosen for it, if any. */
export const findSystemBot = Effect.fn("SystemBots.findSystemBot")(function* (
	db: Executor,
	workspaceId: string,
	key: SystemBotKey,
) {
	const [row] = yield* db
		.select({ id: bot.id, model: bot.model })
		.from(bot)
		.where(and(eq(bot.workspaceId, workspaceId), eq(bot.systemBotKey, key)))
		.limit(1);
	return row;
});

/**
 * The system bot and the model it runs on, or nothing when no model has been
 * chosen, which is what "set up" means for one. A caller cannot reach a system
 * bot and forget that it may not be set up: here `undefined` is the whole
 * answer, and what comes back names a model.
 */
export const findRunnableSystemBot = Effect.fn("SystemBots.findRunnableSystemBot")(function* (
	db: Executor,
	workspaceId: string,
	key: SystemBotKey,
) {
	const [row] = yield* db
		.select({ id: bot.id, model: bot.model })
		.from(bot)
		.where(and(eq(bot.workspaceId, workspaceId), eq(bot.systemBotKey, key), isNotNull(bot.model)))
		.limit(1);
	return row?.model == null ? undefined : { id: row.id, model: row.model };
});
