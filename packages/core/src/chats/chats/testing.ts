import { type Promised, runOnPostgres } from "../../database/testing.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import type { Chats } from "./chats.ts";

/**
 * Starts a chat with the bot `botId` from its first message, as members do:
 * in the bot's default project.
 */
export async function startBotChat(
	chats: Pick<Promised<Chats.Interface>, "startProjectChat">,
	input: { botId: string; messageId: string; content: string },
) {
	return chats.startProjectChat({
		projectId: await runOnPostgres(defaultProjectOf(input.botId)),
		messageId: input.messageId,
		content: input.content,
	});
}
