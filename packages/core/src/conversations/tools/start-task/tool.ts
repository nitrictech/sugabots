import type { BotStartedTask } from "@sugabots/contracts";
import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { BotTasks } from "../../chats/bot-tasks.ts";

const MAX_TITLE_CHARACTERS = 120;
const MAX_BRIEF_CHARACTERS = 8_000;

type StartTaskResult = { task: BotStartedTask } | { refused: string };

/**
 * The `start_task` tool: moves a piece of work that came up in this
 * conversation to a new task, with this bot or another, when the person asks.
 * The new task's bot starts on it at once, from the brief this bot writes.
 */
export function startTaskTool({
	bot,
	tasks,
	run,
}: {
	bot: BotTasks.Bot;
	tasks: Pick<BotTasks.Interface, "start">;
	run: RunEffect;
}) {
	return tool({
		description:
			"Start a new task for a separate piece of work, with you or another bot, when the person asks to take something to a task of its own. The person is added to it, and its bot starts at once on your brief, its first message. Its bot sees only the brief, not this conversation, so include the work and everything it needs from here. Then tell the person you started it, by its title.",
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
					"What the task's bot is to do, with the facts from this conversation it needs. It is the task's first message, from you.",
			}),
			with: Schema.optional(
				Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
					description:
						"The handle of the bot to start it with, like @support. Leave it out to do the work yourself.",
				}),
			),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ title, brief, with: withHandle }): Promise<StartTaskResult> =>
			run(
				tasks.start(bot, { title, brief, ...(withHandle ? { withHandle } : {}) }).pipe(
					Effect.map((task) => ({ task })),
					Effect.catch((refusal) => Effect.succeed({ refused: refusal.userMessage })),
				),
			),
	});
}
