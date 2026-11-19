import { type Promised, runOnPostgres } from "../../database/testing.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import type { Chats } from "./chats.ts";

/**
 * Starts a thread with the bot `botId` from its first message, as people do:
 * in the bot's default project.
 */
export async function startBotThread(
	chats: Pick<Promised<Chats.Interface>, "startProjectThread">,
	input: { botId: string; messageId: string; content: string },
) {
	return chats.startProjectThread({
		projectId: await runOnPostgres(defaultProjectOf(input.botId)),
		messageId: input.messageId,
		content: input.content,
	});
}
