import type { BotParticipant, ChatDetails } from "@sugabots/contracts";
import type { ChatLocation } from "@/lib/chats.ts";

/**
 * The lead bot of the project a chat is in, as the chat lists
 * it: the bot itself in one of a bot's chats, which are its default
 * project's. Undefined until the chat lists it.
 */
export function leadOf(
	place: ChatLocation,
	details: Pick<ChatDetails, "participants" | "projectBots">,
): BotParticipant | undefined {
	const leadId = "project" in place ? place.project.leadBotId : place.bot.id;
	return [...details.projectBots, ...details.participants].find(
		(participant): participant is BotParticipant =>
			participant.kind === "bot" && participant.id === leadId,
	);
}
