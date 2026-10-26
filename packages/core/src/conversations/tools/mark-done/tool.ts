import { tool } from "ai";
import { Effect } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { BotThreads } from "../../chats/bot-threads.ts";
import { noInputSchema } from "../no-input.ts";

export const MARK_DONE_TOOL = "mark_done";

export type MarkDoneResult = { done: true } | { refused: string };

/**
 * The `mark_done` tool: marks this thread done for the person who asks, which
 * takes it off the pod's open threads until somebody posts in it again.
 */
export function markDoneTool({
	bot,
	threadId,
	threads,
	run,
}: {
	bot: BotThreads.Bot;
	/** The thread the bot is in, which is the one marked done. */
	threadId: string;
	threads: Pick<BotThreads.Interface, "markDone">;
	run: RunEffect;
}) {
	return tool({
		description:
			"Mark this thread done, when the person asks you to or agrees the work in it is finished. It leaves the pod's open threads, and opens again when anyone posts in it. Don't mark it done unasked.",
		inputSchema: noInputSchema,
		execute: (): Promise<MarkDoneResult> =>
			run(
				threads.markDone(bot, threadId).pipe(
					Effect.as({ done: true as const }),
					Effect.catch((refusal) => Effect.succeed({ refused: refusal.userMessage })),
				),
			),
	});
}
