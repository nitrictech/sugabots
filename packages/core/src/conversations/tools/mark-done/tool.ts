import { tool } from "ai";
import { Effect } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { BotTasks } from "../../chats/bot-tasks.ts";
import { noInputSchema } from "../no-input.ts";

export const MARK_DONE_TOOL = "mark_done";

type MarkDoneResult = { done: true } | { refused: string };

/**
 * The `mark_done` tool: marks this task done for the person who asks, until
 * somebody posts in it again.
 */
export function markDoneTool({
	bot,
	conversationId,
	tasks,
	run,
}: {
	bot: BotTasks.Bot;
	/** The conversation the bot is in, which is the one marked done. */
	conversationId: string;
	tasks: Pick<BotTasks.Interface, "markDone">;
	run: RunEffect;
}) {
	return tool({
		description:
			"Mark this task done, when the person asks you to or agrees the work in it is finished. It leaves your open tasks, and opens again when anyone posts in it. Don't mark it done unasked.",
		inputSchema: noInputSchema,
		execute: (): Promise<MarkDoneResult> =>
			run(
				tasks.markDone(bot, conversationId).pipe(
					Effect.as({ done: true as const }),
					Effect.catch((refusal) => Effect.succeed({ refused: refusal.userMessage })),
				),
			),
	});
}
