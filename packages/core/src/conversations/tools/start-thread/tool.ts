import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { BotThreads } from "../../chats/bot-threads.ts";

export const START_THREAD_TOOL = "start_thread";

const MAX_TITLE_CHARACTERS = 120;
const MAX_BRIEF_CHARACTERS = 8_000;

export type StartThreadResult = { thread: BotThreads.StartedThread } | { refused: string };

/**
 * The `start_thread` tool: moves a piece of work that came up in this thread
 * to a new thread in the pod, with this bot or another, when the person asks.
 * The new thread's bot starts on it at once, from the brief this bot writes.
 */
export function startThreadTool({
	bot,
	threads,
	run,
}: {
	bot: BotThreads.Bot;
	threads: Pick<BotThreads.Interface, "start">;
	run: RunEffect;
}) {
	return tool({
		description:
			"Start a new thread in this pod for a separate piece of work, with you or another bot in the pod, when the person asks to take something to its own thread. The person is added to it, and its bot starts at once on your brief, its first message. Its bot sees only the brief, not this thread, so include the task and everything it needs from here. Then tell the person you started it, by its title.",
		inputSchema: Schema.Struct({
			title: Schema.Trim.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(MAX_TITLE_CHARACTERS),
			).annotate({ description: 'A short title for the work, like "Refund report for March".' }),
			brief: Schema.Trim.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(MAX_BRIEF_CHARACTERS),
			).annotate({
				description:
					"What the thread's bot is to do, with the facts from this thread it needs. It is the thread's first message, from you.",
			}),
			with: Schema.optional(
				Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
					description:
						"The handle of the pod's bot to start it with, like @support. Leave it out to do the work yourself.",
				}),
			),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ title, brief, with: withHandle }): Promise<StartThreadResult> =>
			run(
				threads.start(bot, { title, brief, ...(withHandle ? { withHandle } : {}) }).pipe(
					Effect.map((thread) => ({ thread })),
					Effect.catch((refusal) => Effect.succeed({ refused: refusal.userMessage })),
				),
			),
	});
}
