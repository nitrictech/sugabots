import type { BotParticipant, ConversationDetails } from "@sugabots/contracts";
import type { ConversationPlace } from "@/lib/chats.ts";

/**
 * The lead bot of the project a conversation is in, as the conversation lists
 * it: the bot itself in one of a bot's threads, which are its default
 * project's. Undefined in a project with no lead yet.
 */
export function leadOf(
	place: ConversationPlace,
	details: Pick<ConversationDetails, "participants" | "projectBots">,
): BotParticipant | undefined {
	const leadId = "project" in place ? place.project.leadBotId : place.bot.id;
	return [...details.projectBots, ...details.participants].find(
		(member): member is BotParticipant => member.kind === "bot" && member.id === leadId,
	);
}
