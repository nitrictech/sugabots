import { tool } from "ai";
import { Effect } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { BotChats } from "../../chats/bot-chats.ts";
import { noInputSchema } from "../no-input.ts";

export const MARK_RESOLVED_TOOL = "mark_resolved";

type MarkResolvedResult = { resolved: true } | { refused: string };

/**
 * The `mark_resolved` tool: marks this chat resolved for the person who asks, until
 * somebody posts in it again.
 */
export function markResolvedTool({
	bot,
	chatId,
	chats,
	run,
}: {
	bot: BotChats.Bot;
	/** The chat the bot is in, which is the one marked resolved. */
	chatId: string;
	chats: Pick<BotChats.Interface, "markResolved">;
	run: RunEffect;
}) {
	return tool({
		description:
			"Mark this chat resolved, when the person asks you to or agrees the work in it is finished. It leaves your open chats, and opens again when anyone posts in it. Don't mark it resolved unasked.",
		inputSchema: noInputSchema,
		execute: (): Promise<MarkResolvedResult> =>
			run(
				chats.markResolved(bot, chatId).pipe(
					Effect.as({ resolved: true as const }),
					Effect.catch((refusal) => Effect.succeed({ refused: refusal.userMessage })),
				),
			),
	});
}
