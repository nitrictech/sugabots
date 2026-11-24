import type { BotStartedChat } from "@sugabots/contracts";
import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { BotChats } from "../../chats/bot-chats.ts";

const MAX_TITLE_CHARACTERS = 120;
const MAX_BRIEF_CHARACTERS = 8_000;

type StartChatResult = { chat: BotStartedChat } | { refused: string };

/**
 * The `start_chat` tool: moves a piece of work that came up in this
 * chat to a new chat with this bot or another, when the member asks.
 * The new chat's bot starts on it at once, from the brief this bot writes.
 */
export function startChatTool({
	bot,
	chats,
	run,
}: {
	bot: BotChats.Bot;
	chats: Pick<BotChats.Interface, "start">;
	run: RunEffect;
}) {
	return tool({
		description:
			"Start a new chat with you or another bot for a separate piece of work, when the member asks to take something to a chat of its own. The member is added to it, and its bot starts at once on your brief, its first message. Its bot sees only the brief, not this chat, so include the work and everything it needs from here. Then tell the member you started it, by its title.",
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
					"What the chat's bot is to do, with the facts from this chat it needs. It is the chat's first message, from you.",
			}),
			with: Schema.optional(
				Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
					description:
						"The handle of the bot to start it with, like @support. Leave it out to do the work yourself.",
				}),
			),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ title, brief, with: withHandle }): Promise<StartChatResult> =>
			run(
				chats.start(bot, { title, brief, ...(withHandle ? { withHandle } : {}) }).pipe(
					Effect.map((chat) => ({ chat })),
					Effect.catch((refusal) => Effect.succeed({ refused: refusal.userMessage })),
				),
			),
	});
}
