import type { BotColor, BotEyes, BotShape, SystemBotKey } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { bot } from "../../database/schema.ts";

/**
 * System bots are protected bots the product runs. A workspace owns one of
 * each, and every bot in it is served by them: nobody places, configures or
 * removes them.
 *
 * One is born without a model, since a new workspace offers none, and is given
 * the first model somebody switches on, which is the one they pick during
 * workspace setup. From then on it always has one: an admin can change it
 * but not clear it, and the workspace cannot stop offering it until the bot
 * is moved to another. Compaction runs on the model of the bot it compacts
 * for, and on its own only for a bot with none.
 */

/** The system bot that compacts what a bot reads when its chat gets long. */
export const COMPACT_SYSTEM_BOT: SystemBotKey = "compact";

interface SystemBotDefinition {
	/** What the system looks the bot up by. */
	key: SystemBotKey;
	name: string;
	description: string;
	color: BotColor;
	eyes: BotEyes;
	shape: BotShape;
	instructions: string;
}

export const SYSTEM_BOTS: readonly SystemBotDefinition[] = [
	{
		key: COMPACT_SYSTEM_BOT,
		name: "Compaction",
		description: "Compacts long chats so bots can keep reading them.",
		color: "purple",
		eyes: "square",
		shape: "circle",
		instructions: "Condense what a bot needs to carry on the chat. Do not invent details.",
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
